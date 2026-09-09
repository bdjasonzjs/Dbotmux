/** Pure transport projection. No Lark API calls. Human raw.body is NEVER
 * rewritten by this module: normalization is only a bot-send readback check.
 * Unknown rich elements fail closed rather than dropping potentially vital text.
 */
import { z } from 'zod';
import { AskHumanPreflightError } from './ask-human-preflight.js';

export const askHumanWireSchema = z.object({
  type: z.enum(['text', 'post']), content: z.string(),
  mentions: z.array(z.object({ key: z.string().min(1), openId: z.string().min(1) }).strict()),
}).strict();
export type AskHumanWireContent = z.infer<typeof askHumanWireSchema>;
function fail(): never { throw new AskHumanPreflightError('READBACK_MISMATCH', '消息原始内容或 mention 不能无损核对'); }

/** Both locally prepared text and returned raw content use this one function.
 * Only CRLF and outer whitespace normalize; inner spaces/newlines stay intact.
 * Only independently identified transport-prefix mentions may be removed.
 */
export function askHumanContentText(input: string | AskHumanWireContent, expectedMentions: string[] = []): string {
  if (typeof input === 'string') return input.replace(/\r\n?/g, '\n').trim();
  const wire = askHumanWireSchema.parse(input);
  let data: unknown;
  try { data = JSON.parse(wire.content); } catch { return fail(); }
  const metadata = [...wire.mentions];
  let body: string;
  if (wire.type === 'text') {
    const parsed = z.object({ text: z.string() }).strict().safeParse(data);
    if (!parsed.success) return fail();
    body = parsed.data.text;
  } else {
    // Lark posts may be direct or wrapped in one locale. Multiple alternative
    // locales are not silently ignored; the future adapter must select/verify.
    if (data && typeof data === 'object' && !('content' in data)) {
      const locales = Object.values(data);
      if (locales.length !== 1) return fail();
      data = locales[0];
    }
    const post = z.object({ title: z.string().optional(), content: z.array(z.array(z.unknown())) }).strict().safeParse(data);
    if (!post.success) return fail();
    const rows = post.data.content.map(row => row.map(node => {
      const t = z.object({ tag: z.literal('text'), text: z.string(), style: z.array(z.enum(['bold', 'italic', 'underline'])).optional(), un_escape: z.boolean().optional() }).strict().safeParse(node);
      if (t.success && !t.data.un_escape) return t.data.text;
      const at = z.object({ tag: z.literal('at'), user_id: z.string().min(1), user_name: z.string().optional(), style: z.array(z.string()).optional() }).strict().safeParse(node);
      if (!at.success) return fail();
      const key = `\u0000at-${metadata.length}\u0000`;
      // Actual post nodes carry identity. No global regexp strips user prose.
      metadata.push({ key, openId: at.data.user_id });
      return key;
    }).join(''));
    body = [...(post.data.title ? [post.data.title] : []), ...rows].join('\n');
  }
  const identities = [...new Set(metadata.map(m => m.openId))].sort();
  if (JSON.stringify(identities) !== JSON.stringify([...new Set(expectedMentions)].sort())) return fail();
  body = body.replace(/\r\n?/g, '\n').trim();
  const consumed = new Set<string>();
  while (consumed.size < expectedMentions.length) {
    const prefix = metadata.find(m => !consumed.has(m.openId) && body.startsWith(m.key));
    if (prefix) { consumed.add(prefix.openId); body = body.slice(prefix.key.length).trimStart(); continue; }
    const xml = /^<at user_id="([a-zA-Z0-9_-]+)">[^<]*<\/at>/.exec(body);
    if (!xml || !identities.includes(xml[1]) || consumed.has(xml[1])) return fail();
    consumed.add(xml[1]); body = body.slice(xml[0].length).trimStart();
  }
  if (body.includes('\u0000')) return fail();
  return body.trim();
}

/** This is the supported outgoing text representation for the future adapter. */
export function askHumanTextWire(body: string, mentions: string[] = []): AskHumanWireContent {
  if (new Set(mentions).size !== mentions.length || mentions.some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) return fail();
  const metadata = mentions.map(openId => ({ openId, key: `<at user_id="${openId}"></at>` }));
  return { type: 'text', content: JSON.stringify({ text: [...metadata.map(m => m.key), body].join(' ') }), mentions: metadata };
}

export function askHumanReadbackMatches(body: string, mentions: string[], message: { body: string; wire?: AskHumanWireContent }): boolean {
  const expected = askHumanContentText(askHumanTextWire(body, mentions), mentions);
  const actual = askHumanContentText(message.wire ?? message.body, mentions);
  // A real adapter includes wire and exposes exactly its extracted pure text.
  return actual === expected && (!message.wire || actual === askHumanContentText(message.body));
}
