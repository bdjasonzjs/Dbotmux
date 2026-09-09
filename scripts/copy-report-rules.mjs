#!/usr/bin/env node
// Ship the single Markdown source beside the compiled built-in skill.
import { copyFileSync, mkdirSync } from 'node:fs';
const source = new URL('../src/skills/references/report-rules.md', import.meta.url);
const directory = new URL('../dist/skills/references/', import.meta.url);
mkdirSync(directory, { recursive: true });
copyFileSync(source, new URL('report-rules.md', directory));
