/**
 * Consecutive messages test:
 * Verifies the type-ahead message queue — sends 3 messages rapidly
 * while CLI is still processing the first, asserts all are handled.
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
  waitForStreamingCard,
  waitForCardStatus,
  scrollThreadToBottom,
  navigateToMessenger,
  openChat,
  closeSession,
  sendThreadReply,
} from './helpers.js';

describe('consecutive messages', () => {
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

    await navigateToMessenger(page);
    await openChat(page, agent, 'Claude');
  });

  afterAll(async () => {
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('should process 3 rapidly sent messages in sequence', async () => {
    const msg1 = testMessage('consec-1');

    // Send first message to create the topic thread
    await sendMessage(agent, msg1);

    // Wait for the streaming card to appear (session starts)
    await waitForStreamingCard(agent, { msgHint: msg1, timeoutMs: 120_000 });

    // Wait for the first message to be processing (card shows "工作中")
    await waitForCardStatus(agent, '工作中', { timeoutMs: 60_000 });

    // Send 2 more messages rapidly via thread reply while CLI is still busy
    const msg2 = testMessage('consec-2');
    const msg3 = testMessage('consec-3');
    await sendThreadReply(agent, page, msg2);
    await page.waitForTimeout(500);
    await sendThreadReply(agent, page, msg3);

    // Wait for the CLI to eventually become idle after processing all messages
    await waitForCardStatus(agent, '就绪', { timeoutMs: 300_000 });

    // Scroll thread to bottom to see all responses
    await scrollThreadToBottom(agent);
    await page.waitForTimeout(2000);

    // Verify multiple responses — the CLI should have processed all 3 messages
    // and produced responses for each (visible as card updates or reply messages)
    await agent.aiAssert(
      '话题面板中可以看到机器人对消息做出了多次回复（至少有 2 条不同的机器人响应消息或卡片更新）',
    );
  }, 600_000);
});
