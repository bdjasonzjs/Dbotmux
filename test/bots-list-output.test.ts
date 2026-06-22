import { describe, expect, it } from 'vitest';

import {
  formatAuthoritativeBotsForCli,
  formatBotInfoEntriesForCli,
  formatChatBotsForCli,
} from '../src/cli/bots-list-output.js';

describe('botmux bots list CLI output mapping', () => {
  it('includes larkAppId and workflowBot for chat-member results', () => {
    const rows = formatChatBotsForCli([
      {
        larkAppId: 'cli_self',
        openId: 'ou_self',
        name: 'codex',
        displayName: 'Codex Loopy',
        source: 'configured',
      },
      {
        larkAppId: 'cli_peer',
        openId: 'ou_peer',
        name: 'claude',
        displayName: 'Claude Loopy',
        source: 'configured',
      },
      {
        larkAppId: '',
        openId: 'ou_external',
        name: 'external-loopy',
        displayName: 'External Loopy',
        source: 'introduce',
      },
    ], 'cli_self');

    expect(rows).toEqual([
      {
        name: 'Codex Loopy',
        openId: 'ou_self',
        isSelf: true,
        source: 'configured',
        larkAppId: 'cli_self',
        workflowBot: 'cli_self',
      },
      {
        name: 'Claude Loopy',
        openId: 'ou_peer',
        isSelf: false,
        source: 'configured',
        larkAppId: 'cli_peer',
        workflowBot: 'cli_peer',
      },
      {
        name: 'External Loopy',
        openId: 'ou_external',
        isSelf: false,
        source: 'introduce',
        larkAppId: '',
        workflowBot: null,
      },
    ]);
  });

  it('includes larkAppId and workflowBot for bots-info fallback rows', () => {
    const rows = formatBotInfoEntriesForCli([
      {
        larkAppId: 'cli_self',
        botOpenId: 'ou_self',
        botName: null,
        cliId: 'codex',
      },
      {
        larkAppId: 'cli_peer',
        botOpenId: 'ou_peer',
        botName: 'Claude Loopy',
        cliId: 'claude',
      },
      {
        larkAppId: 'cli_missing_openid',
        botOpenId: null,
        botName: 'Missing',
        cliId: 'codex',
      },
    ], 'cli_self');

    expect(rows).toEqual([
      {
        name: 'codex',
        openId: 'ou_self',
        isSelf: true,
        source: 'configured',
        larkAppId: 'cli_self',
        workflowBot: 'cli_self',
      },
      {
        name: 'Claude Loopy',
        openId: 'ou_peer',
        isSelf: false,
        source: 'configured',
        larkAppId: 'cli_peer',
        workflowBot: 'cli_peer',
      },
    ]);
  });

  it('includes cloneName, engine, cliId and pm2 status for authoritative inventory rows', () => {
    const rows = formatAuthoritativeBotsForCli([
      {
        larkAppId: 'cli_clone',
        name: '克劳德初号机',
        cloneName: '克劳德初号机',
        cliId: 'claude-code',
        engine: 'claude',
        source: 'clone-dir',
        isClone: true,
        index: null,
        botOpenId: 'ou_clone',
        pm2Name: null,
        pm2Status: 'unknown',
        statusNote: 'clone_not_registered_in_bots_json',
      },
      {
        larkAppId: 'cli_codex',
        name: '蔻黛克斯',
        cloneName: '蔻黛克斯',
        cliId: 'codex',
        engine: 'codex',
        source: 'configured',
        isClone: false,
        index: 1,
        botOpenId: 'ou_codex',
        pm2Name: 'botmux-1',
        pm2Status: 'online',
      },
    ], 'cli_codex');

    expect(rows).toEqual([
      {
        name: '克劳德初号机',
        cloneName: '克劳德初号机',
        openId: 'ou_clone',
        isSelf: false,
        source: 'clone-dir',
        larkAppId: 'cli_clone',
        workflowBot: 'cli_clone',
        cliId: 'claude-code',
        engine: 'claude',
        isClone: true,
        pm2Name: null,
        pm2Status: 'unknown',
        statusNote: 'clone_not_registered_in_bots_json',
      },
      {
        name: '蔻黛克斯',
        cloneName: '蔻黛克斯',
        openId: 'ou_codex',
        isSelf: true,
        source: 'configured',
        larkAppId: 'cli_codex',
        workflowBot: 'cli_codex',
        cliId: 'codex',
        engine: 'codex',
        isClone: false,
        pm2Name: 'botmux-1',
        pm2Status: 'online',
      },
    ]);
  });
});
