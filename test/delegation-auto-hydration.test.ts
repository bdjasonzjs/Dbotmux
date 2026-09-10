import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const roots: string[] = [];
const p5 = fileURLToPath(new URL('../src/delegation/runtime/cost-opt/p5/', import.meta.url));

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test('automatic source collection hydrates same-reader cards in bounded batches while retaining snapshot order', () => {
  const home = mkdtempSync(join(tmpdir(), 'delegation-auto-hydration-'));
  roots.push(home);
  const probe = `
import importlib.util, json, os, time
spec=importlib.util.spec_from_file_location('auto', ${JSON.stringify(join(p5, 'p5-task-auto.py'))})
auto=importlib.util.module_from_spec(spec); spec.loader.exec_module(auto)
calls=[]
def quote(message):
    calls.append(message['message_id'])
    time.sleep(0.10)
    return {'content':'body-'+message['message_id']}
auto.quoted_message=quote
messages=[{'message_id':str(i),'msg_type':'interactive','sender':{'sender_type':'app','id':'cli_role'}} for i in range(8)]
started=time.monotonic(); auto.prefetch_source_bodies(messages, {'cli_role'}); elapsed=time.monotonic()-started
assert elapsed < 0.55, elapsed
assert [m['_auto_source_body'] for m in messages] == ['body-'+str(i) for i in range(8)]
assert sorted(calls)==[str(i) for i in range(8)]
print(json.dumps({'elapsed':elapsed,'count':len(calls)}))
`;
  const result = spawnSync('python3', ['-c', probe], {
    cwd: p5,
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, P5_HOME: home, P5_CONFIG: join(home, 'p5-config.json'), PYTHONDONTWRITEBYTECODE: '1' },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ count: 8 });
});
