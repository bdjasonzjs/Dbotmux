/**
 * Group chat @mention routing tests:
 *
 * Multi-bot group ("普通群聊" has all bots):
 *  1. No @mention → no bot responds at all
 *  2. @mention a specific bot → only that bot responds
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
  sendMentionMessage,
  navigateToMessenger,
  openChat,
  getGroupChatName,
  scrollThreadToBottom,
  waitForStreamingCard,
} from './helpers.js';

describe('feishu group @mention routing', () => {
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
    await openChat(page, agent, getGroupChatName());
  }, 120_000);

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  }, 60_000);

  it('no @mention in multi-bot group → no bot responds', async () => {
    const msg = testMessage('no-mention');
    await sendMessage(agent, msg);

    // Wait 20 seconds — bots should NOT respond without @mention
    await page.waitForTimeout(20_000);

    // Scroll to bottom to see latest state
    await agent.aiScroll(undefined, { direction: 'down', scrollCount: 3 });
    await page.waitForTimeout(1000);

    // Verify: no bot replied to this message at all
    // No "项目仓库管理" card, no streaming card, no text reply
    await agent.aiAssert(
      `消息"${msg}"下方没有任何来自机器人的回复（没有卡片、没有文本消息）。` +
        `"${msg}"应该是群聊中最底部的消息，下面是空白的输入框`,
    );
  }, 120_000);

  it('@mention a single bot → only that bot responds', async () => {
    const msg = testMessage('mention-one');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // Wait for Claude to reply in a thread
    await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg });

    // Wait for idle
    await scrollThreadToBottom(agent);
    await agent.aiWaitFor(
      '话题面板底部的流式卡片标题包含"就绪"',
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );

    // Verify ONLY Claude replied — no other bots
    await scrollThreadToBottom(agent);
    await agent.aiAssert(
      '话题面板中只有 Claude 一个机器人的回复和卡片，' +
        '没有看到 CoCo、Codex、OpenCode 或 Aiden 的回复消息或卡片',
    );
  }, 300_000);
});
