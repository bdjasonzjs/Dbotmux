/**
 * domain injection — 把节点声明的横向知识 topics 解析成可注入的 prompt 段
 * (T5, DEV-CONTEXT §6.5 segment 3「scoped domains top-k」).
 *
 * 节点用 `domains: [topic...]` **显式声明**它消费哪些横向知识——不做语义检索/
 * embedding：显式引用可控、可审计、不臆造，符合 §5.4「harness 引用 domains」的
 * 显式依赖模型。dispatch 时从 domains 库读这些 topic、取 top-k，交给 prompt 渲染器
 * 作为「Domain knowledge」段注入执行 AI 的 prompt。这闭合了横向知识的消费回路：
 * 沉淀 → 晋升 → 装回 → **运行时被用上**。
 *
 * 容错：声明了但库里不存在的 topic（含因非法 key 而读失败的）直接归入 `missing`，
 * 绝不抛、绝不读越界路径——知识缺失不该让工作流挂掉；调用方对比请求/命中/missing
 * 观测覆盖。注：非法 topic 的正道是在 schema 层（definition `DomainTopicSchema`）就
 * 拒绝；这里的 catch 是 dispatch 期的双保险。
 */

import { join } from 'node:path';

import { readDomain, DomainError } from './domains.js';
import type { DomainSnippet } from '../../workflows/prompt-render.js';

export interface ResolveDomainsOptions {
  /** Cap on how many domains to inject (prompt-size guard). Default 5. */
  k?: number;
  /** Cap on each domain body's chars (prompt-size guard). Default 2000. */
  maxChars?: number;
}

export const DEFAULT_DOMAIN_TOP_K = 5;
export const DEFAULT_DOMAIN_MAX_CHARS = 2000;

export interface ResolvedDomains {
  snippets: DomainSnippet[];
  /** Topics requested but not found / not loadable (observability). */
  missing: string[];
}

/**
 * Resolve a node's declared domain topics into injectable snippets, in
 * declaration order, capped at `k` and per-body `maxChars`. Missing or
 * unloadable topics are collected (never thrown).
 */
export async function resolveNodeDomains(
  domainsDir: string,
  topics: readonly string[],
  opts: ResolveDomainsOptions = {},
): Promise<ResolvedDomains> {
  const k = opts.k ?? DEFAULT_DOMAIN_TOP_K;
  const maxChars = opts.maxChars ?? DEFAULT_DOMAIN_MAX_CHARS;
  const snippets: DomainSnippet[] = [];
  const missing: string[] = [];
  for (const topic of topics) {
    if (snippets.length >= k) break;
    let doc;
    try {
      doc = await readDomain(domainsDir, topic);
    } catch (err) {
      // Invalid/unsafe topic key → never read, treat as missing (defense in
      // depth; schema layer should already have rejected it).
      if (err instanceof DomainError) {
        missing.push(topic);
        continue;
      }
      throw err;
    }
    if (!doc) {
      missing.push(topic);
      continue;
    }
    const text = doc.body.length > maxChars ? doc.body.slice(0, maxChars) + '…(truncated)' : doc.body;
    snippets.push({ topic: doc.topic, text });
  }
  return { snippets, missing };
}

/**
 * Resolve the domains library dir for a runtime context. Single source of truth
 * so every real entry point (CLI / IM / daemon / dashboard) wires the same one
 * and behavior doesn't fork. Default = `<cwd>/.agents/domains` (the materialized
 * library, A 方案); override via `BOTMUX_DOMAINS_DIR`. The path is returned even
 * if it doesn't exist — `resolveNodeDomains` degrades missing topics gracefully.
 */
export function resolveDomainsDir(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  const override = env.BOTMUX_DOMAINS_DIR?.trim();
  if (override) return override;
  return join(opts.cwd ?? process.cwd(), '.agents', 'domains');
}
