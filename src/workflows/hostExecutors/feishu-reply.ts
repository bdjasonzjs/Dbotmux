import { replyMessage } from '../../im/lark/client.js';
import { PROVIDER_TTL_MS } from '../events/schema.js';
import type { SideEffectingExecutor } from './types.js';
import { classifyFeishuError } from './feishu-send.js';

export type FeishuReplyInput = {
  larkAppId: string;
  /** Parent message id (om_xxx) being replied to. */
  rootMessageId: string;
  content: string;
  msgType?: string;
  replyInThread?: boolean;
};

export type FeishuReplyOutput = {
  messageId: string;
};

/**
 * `feishu-reply` is similar to `feishu-send` but the canonical input
 * additionally pins `rootMessageId` — spike Test 3c proved that Feishu
 * uuid dedupe IGNORES `parent_id` mismatches, so we must lock the parent
 * into the inputHash; otherwise a retry against a different parent would
 * silently land on the original parent.
 */
export const feishuReplyExecutor: SideEffectingExecutor<FeishuReplyInput, FeishuReplyOutput> = {
  provider: 'feishu-im',
  idempotencyTtlMs: PROVIDER_TTL_MS['feishu-im'],

  canonicalInput(input) {
    return {
      root_message_id: input.rootMessageId,
      msg_type: input.msgType ?? 'text',
      content: input.content,
      reply_in_thread: input.replyInThread ?? false,
      larkAppId: input.larkAppId,
    };
  },

  async invoke(input, idempotencyKey) {
    const messageId = await replyMessage(
      input.larkAppId,
      input.rootMessageId,
      input.content,
      input.msgType ?? 'text',
      input.replyInThread ?? false,
      idempotencyKey,
    );
    return {
      output: { messageId },
      externalRefs: { messageId },
    };
  },

  classifyError: classifyFeishuError,
};
