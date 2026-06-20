# clone integrity gate plan review 1

Review scope: `docs/clone-integrity-gate-plan.md`, Feishu docx `Wcj7dSD2EoCPw8xXKR3cYt2bnqf`, and the current code paths under `src/services/clone-app-preset.ts`, `src/services/ceo-preheat.ts`, `src/services/ceo-clone-orchestration.ts`, `src/im/lark/event-dispatcher.ts`, and `src/services/clone-scope-provisioning.ts`.

Verdict: needs revision before implementation. The plan identifies the right three root areas, but two gate checks are still underspecified in ways that can let a broken clone pass as complete.

## Blockers

1. Scope check cannot rely on the current clone-scope gate as a "full green" signal.

   The plan says the integrity gate checks "scope 全" by reusing clone scope provisioning / application info and blocks on failure. Current `ensureCloneScopesProvisioned()` is deliberately fail-open for unverifiable states: no secret, API error, and especially `scope.list` returning an empty granted list. That behavior is reasonable for avoiding false subgroup lockouts, but it is incompatible with this task's "scope 全 / 未全绿不交付" acceptance criteria.

   Required revision: split the existing advisory/fail-open subgroup gate from the new clone delivery gate. The delivery gate must not treat "cannot verify" as green. If `application.v6.scope.list` is unreliable, define concrete capability probes for the scopes that matter, or mark the scope item `unknown` and block delivery with an auth/remediation summary. Do not reuse the current fail-open result as an integrity pass.

2. "直接 @ 可收" has no concrete ack path in the current routing code.

   The plan lists a direct mention probe plus clone-side ack, but the existing wake-ack write path is only in the urgent-summon branch in `event-dispatcher.ts`. A normal direct @ with `[[wake-ack:...]]` would route through the mention path and would not call `recordWakeAck()`. That means the proposed direct-@ check has no specified implementation hook and can easily become either a no-op or a test-only fake.

   Required revision: define the direct-@ probe protocol explicitly. Either add a separate direct-mention ack token handler before normal prompt routing, or generalize wake-ack recording so both urgent summon and real @ mention can prove receipt. Tests must cover a real mention-shaped message, not only urgent-summon cards.

## High-priority gaps

3. Description source is not wired to an actual caller path yet.

   The plan says `sourceDescription` or chat/CEO explicit description can feed `appPreset.desc`, but current `CloneBotInput` and the CEO clone path do not have that field. `/bot/v3/info` currently only reads `avatar_url`, and existing comments say it has no trustworthy app description. Before coding, specify where the trusted description comes from for the CEO flow and direct CLI/chat clone flow. If the only source is a new user-provided parameter, add that parameter to the plan and validation path.

4. Avatar/description post-scan self-heal may not be possible with the current APIs.

   The plan says "补设（若 SDK 支持）或阻断", but the existing code only pre-fills `registerApp({ appPreset })`; it does not show a post-creation setter for name/avatar/desc. If post-scan mutation is unavailable, the gate should treat these as pre-scan inputs plus post-scan verification only, and failures should block with a clear "cannot auto-heal" reason instead of promising self-heal.

5. Restart remediation needs an exact production hook and boundary.

   The plan names `restartCloneDaemon(appId)` / `activate(appId, { restart: true })` as an injection point, but current `ceo-clone-orchestration` deps only have `registerActivatedBot`, `addBotToChat`, `preheatConfirmOnline`, etc. Add the exact service function and test seam. Also keep runtime restart behind the explicit authorization boundary for live E2E, while allowing unit tests to exercise the injected behavior.

## Non-blocking observations

- The root-cause read on interactive urgent cards is credible: the current code only calls `resolveNonsupportMessage()` for interactive messages when raw `message.content` contains `急急如律令`, so cards whose useful text is only available after resolution can be missed.
- The preheat failure read is correct: current orchestration warns, then still calls `lateKickoff()`, marks `joined`, clears state, and emits `子群齐活`.
- `git diff --check` passes for the current docs-only worktree.

## Requested changes before implementation

Update the plan to explicitly model each integrity item as `pass | repaired | blocked | unknown`, where `unknown` is not green. In particular, make "scope 全" and "直接 @ 可收" real runtime probes with production ack paths, not inferred checks. After that, implementation can proceed in the same shared worktree.
