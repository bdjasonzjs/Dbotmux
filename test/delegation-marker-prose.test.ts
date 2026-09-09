import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

const runtime = new URL('../src/delegation/runtime/cost-opt/p5/', import.meta.url).pathname;
function parse(text: string) {
  const result = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from p5lib import find_markers
try:
    print(json.dumps({'markers': find_markers(json.load(sys.stdin))}))
except ValueError as error:
    print(json.dumps({'error': str(error)}))
`, runtime], { input: JSON.stringify(text), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

test.each([
  'A prose example starts with `[p5:` and continues in ordinary words.',
  '讨论未闭合前缀：[p5: 后面是说明文字。',
  'A placeholder [p5:...] is not a protocol message.',
  'A later prose bracket closes [p5: this example ] but it is still prose.',
])('ignores non-base64 prose candidates: %s', (text) => {
  expect(parse(text)).toEqual({ markers: [] });
});

test.each(['[p5:eyJ0YXNrX2V2ZW50Ijoib2sifQ', '[p5:AAAA]', '[p5:abcde]'])('keeps explicit errors for corrupt protocol candidates: %s', (text) => {
  expect(parse(text).error).toMatch(/^invalid p5 marker #1 offset=0: /);
});

test('canonical writer and both base64 alphabets still round-trip two markers', () => {
  const result = spawnSync('python3', ['-c', `
import base64, json, sys
sys.path.insert(0, sys.argv[1])
from p5lib import canonical, encode_marker, find_markers
source = {'task_event_source': {'task_version': 4, 'event_type': 'milestone'}}
report = {'task_report': {'summary': '\uffff'}}
url = encode_marker(source)
assert url == '[p5:' + base64.urlsafe_b64encode(canonical(source).encode()).decode().rstrip('=') + ']'
standard = base64.b64encode(canonical(report).encode()).decode()
assert '+' in standard or '/' in standard
assert find_markers(url + ' [p5:' + standard + ']') == [source, report]
assert find_markers(url + ' prose example [p5: unfinished explanation') == [source]
print(json.dumps({'ok': True}))
`, runtime], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});
