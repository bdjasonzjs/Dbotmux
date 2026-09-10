/**
 * The two things these commands exist to make impossible:
 *   - sending from the app that is supposed to be woken (the message is
 *     discarded as that app's own echo, so the @ reaches nobody), and
 *   - treating a returned message id as proof that anyone was mentioned.
 *
 * Both used to be facts an agent had to remember. These tests pin them down as
 * behaviour, so a later refactor that "simplifies away" the relay hop or the
 * read-back fails here instead of in a silent chat.
 */
import { describe, it, expect } from 'vitest';
import { pickSender, mentionLanded } from '../src/cli/delegation-relay.js';

describe('pickSender', () => {
  it('keeps the caller as sender when it is not the recipient', () => {
    expect(pickSender('cli_a', 'cli_b', ['cli_a', 'cli_b'], ['cli_a', 'cli_b'])).toBe('cli_a');
  });

  it('hands the send to a third app when caller and recipient are the same app', () => {
    // cli_b is both the caller and the target: its own daemon would drop this
    // message as an echo, so the send must go out as cli_c instead.
    expect(pickSender('cli_b', 'cli_b', ['cli_b', 'cli_c'], ['cli_b', 'cli_c'])).toBe('cli_c');
  });

  it('refuses rather than sending as the recipient when no relay is available', () => {
    // A relay must be BOTH in the chat and credentialed here. Neither alone is
    // enough, and "send anyway" is not an option: it would look like success.
    expect(pickSender('cli_b', 'cli_b', ['cli_b'], ['cli_b', 'cli_c'])).toBeNull();
    expect(pickSender('cli_b', 'cli_b', ['cli_b', 'cli_c'], ['cli_b'])).toBeNull();
  });
});

describe('mentionLanded', () => {
  const ok = { items: [{ mentions: [{ id: 'ou_target' }] }] };

  it('accepts a read-back that really carries the mention', () => {
    expect(mentionLanded(ok, 'ou_target')).toBe(true);
  });

  it('rejects a delivered message whose mentions are empty', () => {
    // This is the shape a send returns when the @ was stripped: the message is
    // there, the id is real, and nobody was woken.
    expect(mentionLanded({ items: [{ mentions: [] }] }, 'ou_target')).toBe(false);
    expect(mentionLanded({ items: [{}] }, 'ou_target')).toBe(false);
  });

  it('rejects a mention of somebody else', () => {
    expect(mentionLanded({ items: [{ mentions: [{ id: 'ou_other' }] }] }, 'ou_target')).toBe(false);
  });

  it('reads the un-wrapped message shape too', () => {
    expect(mentionLanded({ mentions: [{ id: 'ou_target' }] }, 'ou_target')).toBe(true);
  });
});
