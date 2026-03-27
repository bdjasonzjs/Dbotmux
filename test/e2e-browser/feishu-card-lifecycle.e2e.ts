/**
 * Card lifecycle test (consolidated single test):
 *  1. Card status: 启动中… / 工作中 → 就绪
 *  2. Toggle button exists
 *  3. Expanded content has no abnormal characters
 *
 * All assertions reference the specific test message to avoid
 * confusion with old test threads in the chat.
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
  navigateToMessenger,
  openChat,
} from './helpers.js';

describe('feishu card lifecycle', () => {
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
    await openChat(agent, 'Claude');
  }, 60_000);

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('full card lifecycle: active status → toggle → no artifacts → idle', async () => {
    const msg = testMessage('card');
    await sendMessage(agent, msg);

    // --- Step 1: Streaming card appears ---
    await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg });

    // --- Step 2: Verify toggle button exists on this card ---
    await agent.aiAssert(
      `在"${msg}"话题中的流式卡片（标题含"🖥️"）里，` +
        '可以看到"📕 收起输出"或"📖 展开输出"按钮',
    );

    // --- Step 3: Ensure expanded and check content ---
    const needExpand = await agent.aiBoolean(
      `"${msg}"话题中的流式卡片里有"📖 展开输出"按钮（说明当前是收起的）`,
    );
    if (needExpand) {
      await agent.aiAct(
        `点击"${msg}"话题中流式卡片里的"📖 展开输出"按钮`,
      );
      await page.waitForTimeout(2000);
    }

    await agent.aiAssert(
      `"${msg}"话题中流式卡片展开的输出内容是可读的正常文本，` +
        '不包含类似 [32m 或 [0m 的 ANSI 转义序列，' +
        '不包含乱码或不可读字符',
    );

    // --- Step 4: Wait for idle status ---
    await agent.aiWaitFor(
      `"${msg}"话题中的流式卡片标题中包含"就绪"（格式类似"🖥️ ${msg} — 就绪"）`,
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );
  }, 300_000);
});
