import { cpSync, mkdirSync } from 'node:fs';
const source = new URL('../src/squad/templates/', import.meta.url);
const target = new URL('../dist/squad/templates/', import.meta.url);
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
