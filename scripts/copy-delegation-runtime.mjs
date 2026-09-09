import { cpSync, mkdirSync } from 'node:fs';
const source = new URL('../src/delegation/runtime/', import.meta.url);
const target = new URL('../dist/delegation/runtime/', import.meta.url);
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
