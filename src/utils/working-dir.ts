import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function expandHomePath(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function parseWorkingDirList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap(v => parseWorkingDirList(v))
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function configuredWorkingDirs(input: { workingDir?: unknown; workingDirs?: unknown }): string[] {
  const dirs = [
    ...parseWorkingDirList(input.workingDir),
    ...parseWorkingDirList(input.workingDirs),
  ];
  const seen = new Set<string>();
  return dirs.filter(dir => {
    const resolved = resolve(expandHomePath(dir));
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

export function invalidWorkingDirs(input: { workingDir?: unknown; workingDirs?: unknown }): string[] {
  const invalid: string[] = [];
  for (const dir of configuredWorkingDirs(input)) {
    const resolved = resolve(expandHomePath(dir));
    try {
      if (!statSync(resolved).isDirectory()) invalid.push(resolved);
    } catch {
      invalid.push(resolved);
    }
  }
  return invalid;
}
