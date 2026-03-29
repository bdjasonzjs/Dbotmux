/**
 * Shared factory for per-bot E2E tests.
 * Each bot gets its own test file (for parallel execution).
 *
 * Test flow per bot:
 *  1. Navigate to messenger → click bot's private chat
 *  2. Send "hello" → bot creates topic and replies
 *  3. Verify streaming card appears
 *  4. Wait for card to reach "就绪"
 *  5. Verify bot sent an actual reply message (with @mention to user)
 *  6. Close session and verify "会话已关闭"
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { existsSync } from 'node:fs';
import {
  createBrowser,
  createPage,
  createAgent,
  checkPrerequisites,
  STORAGE_STATE_PATH,
  testMessage,
  sendMessage,
  navigateToMessenger,
  openChat,
  waitForStreamingCard,
  scrollThreadToBottom,
  closeSession,
  type BotName,
} from './helpers.js';

export function createBotTest(botName: BotName): void {
  describe(`${botName} basic flow`, () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let agent: PlaywrightAgent;

    beforeAll(async () => {
      checkPrerequisites();
      if (!existsSync(STORAGE_STATE_PATH)) {
        throw new Error(
          'storageState.json not found. Run: pnpm test:e2e-browser:setup',
        );
      }
      browser = await createBrowser();
      ({ context, page } = await createPage(browser));
      agent = createAgent(page);
    });

    afterAll(async () => {
      await closeSession(agent, page);
      await agent?.destroy();
      await context?.close();
      await browser?.close();
    }, 60_000);

    it(`sends hello, receives streaming card and actual reply from ${botName}`, async () => {
      await navigateToMessenger(page);
      await openChat(page, agent, botName);

      const msg = testMessage(botName.toLowerCase());
      await sendMessage(agent, msg);

      // Wait for streaming card in thread panel
      await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg });

      // Wait for card to reach idle — means CLI finished processing
      await scrollThreadToBottom(agent);
      await agent.aiWaitFor(
        '话题面板底部的流式卡片标题包含"就绪"',
        { timeoutMs: 120_000, checkIntervalMs: 5_000 },
      );

      // KEY: Verify bot sent an ACTUAL reply message, not just status.
      // A real reply is a text message from the bot containing @用户,
      // visible below or near the streaming card. It must NOT be just
      // "继续使用当前仓库" or "项目仓库管理" — those are setup messages.
      await scrollThreadToBottom(agent);
      await agent.aiAssert(
        `话题面板中有来自 ${botName} 的文本回复消息（包含"@"某用户的内容），` +
          '这条消息不是"继续使用当前仓库"或"项目仓库管理"等状态消息，' +
          '而是机器人对用户问题的实际回答',
      );
    }, 300_000);
  });
}
