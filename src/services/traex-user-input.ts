import type { AskOption, AskQuestion } from '../core/ask-types.js';

export interface TraexUserInputQuestion {
  id: string;
  question: AskQuestion;
}

export type TraexUserInputParseResult =
  | { kind: 'answerable'; questions: TraexUserInputQuestion[] }
  | { kind: 'unsupported'; reason: string };

/**
 * Convert TRAE's app-server requestUserInput payload into the existing
 * button-card contract. The card cannot faithfully represent a free-text or
 * malformed question, so a mixed batch must not silently drop those questions.
 */
export function parseTraexUserInputQuestions(params: unknown): TraexUserInputParseResult {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { kind: 'unsupported', reason: 'missing request parameters' };
  }
  const rawQuestions = (params as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { kind: 'unsupported', reason: 'missing questions' };
  }

  const questions: TraexUserInputQuestion[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rawQuestions.length; index++) {
    const raw = rawQuestions[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { kind: 'unsupported', reason: `question ${index + 1} is malformed` };
    }
    const question = raw as Record<string, unknown>;
    if (!Array.isArray(question.options) || question.options.length < 2) {
      return { kind: 'unsupported', reason: `question ${index + 1} has fewer than two options` };
    }

    const options: AskOption[] = [];
    for (const option of question.options) {
      if (!option || typeof option !== 'object' || Array.isArray(option)) {
        return { kind: 'unsupported', reason: `question ${index + 1} has a malformed option` };
      }
      const label = (option as Record<string, unknown>).label;
      if (typeof label !== 'string' || !label.trim()) {
        return { kind: 'unsupported', reason: `question ${index + 1} has an invalid option label` };
      }
      options.push({ key: label, label });
    }

    const id = typeof question.id === 'string' && question.id ? question.id : `q${index}`;
    if (ids.has(id)) {
      return { kind: 'unsupported', reason: `duplicate question id: ${id}` };
    }
    ids.add(id);
    const prompt = typeof question.question === 'string' && question.question.trim()
      ? question.question
      : typeof question.header === 'string' && question.header.trim()
        ? question.header
        : `Question ${index + 1}`;
    questions.push({
      id,
      question: {
        prompt,
        multiSelect: question.multiSelect === true,
        options,
      },
    });
  }
  return { kind: 'answerable', questions };
}
