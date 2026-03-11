import { execSync } from 'node:child_process';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

export function createCodexAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'codex');
  return {
    id: 'codex',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      // Codex uses subcommand pattern: `codex resume <id>` for resume, plain `codex` for new
      const args: string[] = [];
      if (resume) {
        args.push('resume', sessionId);
      }
      args.push('--dangerously-bypass-approvals-and-sandbox');
      args.push('--no-alt-screen');   // inline mode for PTY capture
      return args;
    },

    async writeInput(pty: PtyHandle, content: string) {
      pty.write(content + '\r');
    },

    ensureMcpConfig(entry: McpServerEntry) {
      // Use `codex mcp add` CLI to register MCP server
      const envArgs = Object.entries(entry.env)
        .map(([k, v]) => `--env ${k}=${v}`)
        .join(' ');
      const cmd = `${bin} mcp add ${entry.name} ${envArgs} -- ${entry.command} ${entry.args.join(' ')}`;
      try {
        execSync(cmd, { encoding: 'utf-8', timeout: 10_000, stdio: 'ignore' });
      } catch (err: any) {
        // May fail if already registered — not critical
        console.warn(`[codex] Failed to add MCP config: ${err.message}`);
      }
    },

    completionPattern: undefined,
    altScreen: false,   // --no-alt-screen disables alternate screen
  };
}

export const create = createCodexAdapter;
