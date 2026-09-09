#!/usr/bin/env node
// Isolated CLI fixture: never calls a real provider.
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
if (process.env.NODE_CHANNEL_FD || process.env.NODE_CHANNEL_SERIALIZATION_MODE) process.exit(99);
appendFileSync(process.env.ASK_HUMAN_TEST_LOG, JSON.stringify(args) + '\n');
const identity = flag('--as');
if (args.includes('+chat-members-list')) {
  if (process.env.ASK_HUMAN_TEST_MODE === 'read-failed') {
    process.stderr.write(JSON.stringify({ ok: false, error: { type: 'authorization' } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, data: { bots: [{ app_id: 'cli_source', member_id: `ou_source_from_${identity}` }] } }));
} else if (identity === 'user' && process.env.ASK_HUMAN_TEST_MODE !== 'success') {
  const error = process.env.ASK_HUMAN_TEST_MODE === 'refused'
    ? { type: 'authorization', code: 230027 } : { type: 'rate_limit' };
  process.stderr.write(JSON.stringify({ ok: false, error }));
  process.exit(1);
} else {
  if (process.env.BOTMUX_CHAT_ID !== 'oc_source' || process.env.BOTMUX_SESSION_ID !== 'source-session' || process.env.BOTMUX_LARK_APP_ID !== 'cli_source') process.exit(98);
  console.log(JSON.stringify({ ok: true, data: { message_id: `om_${identity}` } }));
}
