# 设计：任务小组新类型「需求开发 + e2e 验证」（tt_type_dev_with_e2e）

> Owner：克劳德（功能迭代）。方向已由松松拍板（2026-06-30）：**搞新类型**（不是在 two_layer_review 上加开关）。
> 背景：现在有了真机 e2e 能力——豆包M（Codex bot，跑松松 Mac 物理机）能跑桌面端 e2e。之前需求开发小组报 done 时其实没真机验证过。新类型 = 在「开发→review」后插一道真机 e2e 关，过了才算完成。

## 一、为什么是新类型（不是 flag）
引擎是声明式 config（roles[]/rules[]/teamTypes[]，类型=一份 config bundle）。e2e 这关带 **独立主体（豆包M，跨机器 external）+ 独立阶段 + 独立完成判定**，是真·新形态，不是一个布尔能干净表达的。做新类型 = 纯加 config、引擎代码零改动，最符合「形态=配置」哲学。（与 MoA 那次「别新类型、改现有类型」不冲突：那次是给现有类型打补丁绕其固有逻辑，这次是真新形态。）

## 二、形态（一句话）
开发 → 架构 review 过 → 详细 review 过 → **豆包M 真机 e2e 关** → 才算完成。

## 三、Config（参照 two_layer_review + 复用 moa_monitor 的外部消息→事件机制）

现有 `tt_type_two_layer_review`（src/services/taskteam-config-store.ts:170+）的 rules 链：
- submit → architect request-review（running→reviewing）
- review-pass(architect) → detail_reviewer request-review
- review-pass(detail_reviewer) → **developer report（→ done）**  ← 新类型在这里改道
- review-reject → developer nudge（rework）
- stall → observer escalate

**新类型 `tt_type_dev_with_e2e`**：
- **Roles**：developer / architect / detail_reviewer / observer（同上）+ 新增 **e2e_runner**（绑豆包M，attribution=**external**——它在另一台机器，群消息是唯一信号，和 moa_monitor 的 external 主体同理）。
- **Slots**：+ `tt_slot_e2e_runner_main`（豆包M）。
- **Events**：submit / review-pass / review-reject / stall（同上）+ 新增 **e2e-pass / e2e-fail**（由 observer 判读豆包M的群回报产生，机制 = moa_monitor 的 judge.outputEventRegistry，src/services/taskteam-moa-monitor.ts）。
- **Rules**（把 two_layer 的"detail pass→done"改道为"→e2e关"，并加 e2e 收尾两条）：
  1. submit → architect request-review
  2. review-pass(architect) → detail_reviewer request-review
  3. **review-pass(detail_reviewer) → e2e_runner『派 e2e』**（do: notify/request-review，状态进 e2e 验证态）——动作里把**实例配置的四项**（装哪个包/哪个分支/测哪些 case/用哪个 skill）@ 豆包M 发到群里。
  4. **e2e-pass → developer report（→ done）**。
  5. **e2e-fail → developer（do: nudge，带 e2e 失败详情）**（松松 2026-06-30 拍板）：把球**踢回开发者诊断**——开发者看具体啥问题，**能修就修**（修完重走 e2e）、**修不了就向上反馈**（开发者自己 escalate/askforhelp 给人）。= 先用 AI 开发者过滤一道，只有真搞不定的才惊动人。**机制与 review-reject 完全相同**（都是 →developer 踢回让它改），区别只是 e2e-fail 的 nudge 文案多带「修不了就上报」的指引 + 附 e2e 失败证据。

## 四、跨机器怎么接（关键）
豆包M 在松松 Mac、**进不了我们的 subtask 编排 store**（store 不跨机器）。所以走**消息层**，完全复用已上线的能力：
- 派 e2e（rule 3 触发）：引擎在小组群里 `@豆包M` + 发那四项 kickoff（= shared_knowledge 的 `cua/doubao-desktop-e2e-kickoff-template.md` 四项）。
- 豆包M 跑完在群里发回报。
- 缇蕾（observer）盯群，judge 判 pass/fail → emit e2e-pass / e2e-fail → 引擎推进。这 = moa_monitor 的「外部消息→observer detect→事件」范式，**不用新造引擎能力**。
- 豆包M 的 Mac 非 7x24 → 这关**异步**：容忍它离线、上线再跑、不瞎催（e2e 验证态豁免 stall-nudge，类似经理群豁免）。

## 五、实例配置（四项 task-specific 输入）
建这个类型的小组时，连 e2e 四项一起配（存 instance 级）：①装哪个客户端包 ②用哪个分支编本地前端资源 ③测哪些 case + 预期 ④验证用哪个 skill（默认 doubao-desktop-cdp-verification）。rule 3 触发时把这四项发给豆包M。

## 六、开发范围 / 边界
- 纯 config 化新增类型 + e2e 外部事件接线 + 实例 e2e 配置字段；引擎核心 decide 逻辑尽量不改（若 external-event judge 需要小扩展，按 moa 范式扩，别动通用 decide）。
- base = Dbotmux master，新开 worktree。**停 working tree，commit/push/部署需松松授权**。
- 验收：新类型能建组、走完 开发→review→e2e关→done；e2e-fail 踢回开发者诊断（能修修/修不了上报，同 review-reject 机制）；豆包M 离线时不刷屏；既有 two_layer_review / cron_task 零回归（全量测试绿）。

## 七、待确认 / 风险
- e2e 验证态的「状态名」是复用 reviewing 还是新增 e2e-verifying：开发时看引擎 status 约束定，倾向新增独立态便于豁免 stall + 清晰。
- 豆包M 的 slot 怎么绑「另一台机器的 bot」：external 主体只认群消息发送者身份，不需要它进编排；确认 role attribution=external 的判读不依赖 fromSlotId（同 moa new-bug）。
- judge 判 pass/fail 的提示词准确性：参考 cron new-bug 的 detect()，给清晰 pass/fail 判据，避免误判。
