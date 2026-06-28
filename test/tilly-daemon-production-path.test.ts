import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('tilly scout daemon production path', () => {
  it('passes the resolved main Claude CEO app id into analyzeMessages', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf-8');
    expect(src).toContain("const claudeIdent = resolveBotIdent('claude')");
    expect(src).toMatch(/analyzeMessages\(fresh,\s*\{\s*knownHandled,\s*mainClaudeCeoAppId:\s*claudeIdent\.larkAppId,\s*\}\s*\)/s);
  });
});
