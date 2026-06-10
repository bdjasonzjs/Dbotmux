/**
 * Tests for T4 — require-evidence guard (pure evaluation).
 * Service-layer wiring into requestReview is covered in
 * subtask-orchestrator.test.ts (the 422 HARD STOP case).
 */

import { describe, it, expect } from 'vitest';
import { evaluateRequireEvidence, isEvidenceLink } from '../src/services/context/guard.js';

describe('isEvidenceLink — shape', () => {
  it('accepts http(s) URLs and absolute paths', () => {
    expect(isEvidenceLink('https://x/doc')).toBe(true);
    expect(isEvidenceLink('http://x')).toBe(true);
    expect(isEvidenceLink('/tmp/report.md')).toBe(true);
    expect(isEvidenceLink('  /abs/with/space  ')).toBe(true);
  });
  it('rejects shapeless tokens / relative paths / non-strings', () => {
    expect(isEvidenceLink('foo')).toBe(false);
    expect(isEvidenceLink('./rel')).toBe(false);
    expect(isEvidenceLink('')).toBe(false);
    expect(isEvidenceLink(undefined)).toBe(false);
  });
});

describe('evaluateRequireEvidence', () => {
  it('passes when an observation carries an openable evidence link', () => {
    const r = evaluateRequireEvidence([
      { evidenceLinks: [] },
      { evidenceLinks: ['/tmp/report.md'] },
    ]);
    expect(r.ok).toBe(true);
    expect(r.code).toBe('require-evidence');
  });

  it('fails on no observations', () => {
    const r = evaluateRequireEvidence([]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no openable verification evidence/i);
  });

  it('fails when all evidence links are empty / whitespace', () => {
    expect(evaluateRequireEvidence([{ evidenceLinks: [] }]).ok).toBe(false);
    expect(evaluateRequireEvidence([{ evidenceLinks: ['', '   '] }]).ok).toBe(false);
    expect(evaluateRequireEvidence([{}]).ok).toBe(false);
  });

  it('does NOT count shapeless tokens as evidence (foo is not openable)', () => {
    expect(evaluateRequireEvidence([{ evidenceLinks: ['foo'] }]).ok).toBe(false);
    expect(evaluateRequireEvidence([{ evidenceLinks: ['foo', 'bar'] }]).ok).toBe(false);
    // mixed: one openable link is enough
    expect(evaluateRequireEvidence([{ evidenceLinks: ['foo', 'https://x/d'] }]).ok).toBe(true);
  });
});
