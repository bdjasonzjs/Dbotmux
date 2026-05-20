import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredWorkingDirs, invalidWorkingDirs, parseWorkingDirList } from '../src/utils/working-dir.js';

describe('working-dir utils', () => {
  it('parses comma-separated strings and arrays', () => {
    expect(parseWorkingDirList('/a, /b,,/c')).toEqual(['/a', '/b', '/c']);
    expect(parseWorkingDirList(['/a, /b', ' /c '])).toEqual(['/a', '/b', '/c']);
    expect(parseWorkingDirList(undefined)).toEqual([]);
  });

  it('dedupes configured dirs by resolved path', () => {
    const cwd = process.cwd();
    expect(configuredWorkingDirs({ workingDir: '., ' + cwd })).toEqual(['.']);
  });

  it('reports missing paths and files as invalid dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-working-dir-'));
    const file = join(dir, 'not-a-dir');
    const missing = join(dir, 'missing');
    writeFileSync(file, 'x');

    expect(invalidWorkingDirs({ workingDir: [dir, file, missing] })).toEqual([
      resolve(file),
      resolve(missing),
    ]);
  });
});
