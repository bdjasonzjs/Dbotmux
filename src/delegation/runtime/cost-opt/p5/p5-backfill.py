#!/usr/bin/env python3
"""p5-backfill.py [--chat <oc_full_id>] [--apply --authorized-by <verified owner open_id> --plan-sha <sha>] [--normalize-polluted]
一次性迁移（默认 dry-run 只出计划）。逐 state 分类，绝不静默 skip：
  managed                 已迁移 → 不动
  legacy_no_lifecycle     无 lifecycle → 非候选：写 lifecycle(active/gen0) + schema 4 + 来源，前置 = wake 实物 cron=1/instant=on；候选（config.finished_candidates，设计 v7 固定 5 群）：unmanaged + candidate_since，前置 = cron=0（instant off 则开回 on 并读回）
  schema4_no_provenance   早期 bootstrap 的 schema 4（有 lifecycle、缺 p5_managed）→ 补 wake 读回 + 来源，前置 = wake 满足其 lifecycle.status 的不变式
  schema3_with_lifecycle  污染态 → 需 --chat 单群绑定 + --normalize-polluted：不删字段，补 wake 读回、schema 4、paused 一致、来源(normalized_from)；前置同上
  invalid_lifecycle       schema 4 但 lifecycle 深校验失败 → REFUSED（backfill 不修）
  wake_precondition       wake 实物不满足目标初态不变式（如非候选 legacy cron=0）→ REFUSED（owner 先修 wake 或改 allowlist）
授权语义（r11 P2-1 + r12 P1-3）：
  * 精确绑定：--chat 必须与 state.chat_id 全值相等（同 short 伪 full id 拒绝）；--authorized-by 必须是 config.owners 里 verified_at 有效的 owner_open_id。
  * --apply 必须带 --plan-sha = 同目标集只读计划的 sha；sha 覆盖 (target, normalize, candidate allowlist) + 每群 (chat, class, preimage_sha, wake 全量读回(cron entry9 + instant), candidate, action, post{status,cron,instant})；任何目标的 state 字节 / wake 实物 / 分类 / 后置漂移 → rc 2 零写。
  * 全局 preflight：目标集中存在任何 REFUSED 类别 → 整次零写 rc 2，绝不 partial apply。
  * 原子写：按 chat 全序持有全部目标锁 → 锁内一次性重验每群 (state 字节, wake, class, post) 与计划逐字一致 → 逐群写（写前 preimage 备份）→ 逐群 managed 读回；任一步失败 → 已写目标全部回滚（state 字节恢复 preimage、翻过的 instant 回翻）→ rc 1，净变化为零。
  * --normalize-polluted 必须与 --chat 同用；不带 --chat 处理全 fleet。
  * r13 P1-2 wake 线性化：锁内 build_plan 后记录 botmux store 快照（schedules.json + chat-policies.json 字节 sha）作 CAS 基线；每群写前逐字核 wake_actual==计划 rec.wake 且 store 未变；
    候选翻 instant 后按目标 postcondition 重读实物并刷新基线；全部写完后 fleet post-readback（每群实物 wake 满足 post 不变式 + managed）+ store CAS；任一漂移 → 回滚全部。
    （botmux 的 schedule/watch 写者不持我们的锁；store CAS 把"计划→提交"窗口内任何 store 变化都判为冲突并回滚。）
  * r13 P1-3 durable 事务：run 目录 `p5-backfill-<ts>-<uuid8>`（不碰撞）；写前先落 `manifest.prepare.json`（全部目标 preimage sha/wake/授权/plan_sha）并读回；
    每群写后追加 `progress.jsonl`（fsync）；全部完成 + post-readback 后原子写 `manifest.json`（committed）并读回校验；manifest 任一步失败 → 回滚全部并读回验证。
    回滚自身失败 → 落 `manifest.partial.json`（durable）+ 账本告警，rc 3（不宣称 net zero）。`--recover <run_dir>`：按 prepare+progress 把该 run 已写目标恢复 preimage、回翻 instant，落 `manifest.rolledback.json`。
exit：0 计划/写入完成；1 写入失败已回滚（净零）；2 拒绝（零写）；3 回滚失败（partial，需人工/repair）。"""
import sys, os, json, shutil, uuid, subprocess; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
from p5core import all_chats
a = sys.argv[1:]
if a[:1] == ['--recover']:
    # 恢复协议：prepare 存在、manifest.json（COMMITTED）不存在 → 按 progress.jsonl 把该 run 已写目标恢复 preimage 字节、回翻 instant；读回验证后落 manifest.rolledback.json
    rd = a[1] if len(a) > 1 else ''
    pp = os.path.join(rd, 'manifest.prepare.json')
    if not os.path.isfile(pp): print(f'REFUSED: {rd!r} has no manifest.prepare.json', file=sys.stderr); sys.exit(2)
    if os.path.isfile(os.path.join(rd, 'manifest.json')): print('nothing to recover: run is COMMITTED'); sys.exit(0)
    if os.path.isfile(os.path.join(rd, 'manifest.rolledback.json')): print('nothing to recover: run already ROLLED_BACK'); sys.exit(0)
    prep = json.load(open(pp)); prog = read_jsonl(os.path.join(rd, 'progress.jsonl')) if os.path.exists(os.path.join(rd, 'progress.jsonl')) else []
    phases = {}
    for p in prog: phases.setdefault(p['chat'], []).append(p)
    errs = []; restored = []; untouched = []; notes = []
    # r14 P1-2：不把"没有 progress"当"没有写"——遍历 prepare 的全部目标，按 (state preimage / 本 run image / 其它) × (instant pre / current) × 已落盘 phase 重算
    with AuthLocks(*[t['chat'] for t in prep['targets']]):
        for t in reversed(prep['targets']):
            c = t['chat']; ph = [p.get('phase') for p in phases.get(c, [])]; flip_receipt = 'instant_flipped' in ph  # r15 P1-2：只有动作回执才证明 instant 是本 run 打开的；intent 只证明"准备做"，不是归属证据
            try:
                cur_b = open(p_state(c), 'rb').read(); cur_sha = sha256b(cur_b); cur = json.loads(cur_b.decode('utf-8')) if cur_b else None
                is_run_image = isinstance(cur, dict) and (cur.get('p5_managed') or {}).get('run_id') == prep['run_id']
                touched = False
                if cur_sha != t['preimage_sha']:
                    if not is_run_image: raise RuntimeError(f'state is neither the preimage nor this run\'s image (sha {cur_sha[:12]}); manual decision')
                    bkf = os.path.join(rd, os.path.basename(p_state(c))); pre = open(bkf, 'rb').read()
                    if sha256b(pre) != t['preimage_sha']: raise RuntimeError('backup preimage sha mismatch')
                    atomic_write(p_state(c), pre)
                    if open(p_state(c), 'rb').read() != pre: raise RuntimeError('preimage readback mismatch');
                    touched = True
                cur_inst = instant_state(c); pre_inst = t['wake']['instant']
                if cur_inst != pre_inst:
                    if pre_inst == 'off' and cur_inst == 'on' and flip_receipt:
                        instant_set(c, False)
                        if instant_state(c) != 'off': raise RuntimeError('instant un-flip readback mismatch')
                        touched = True
                    else: raise RuntimeError(f'instant {cur_inst} != preimage {pre_inst} without an action receipt (uncertain: may be an external legitimate writer); left as-is (open), manual decision')
                if instant_state(c) != pre_inst or open(p_state(c), 'rb').read() != (open(os.path.join(rd, os.path.basename(p_state(c))), 'rb').read() if os.path.exists(os.path.join(rd, os.path.basename(p_state(c)))) else cur_b if cur_sha == t['preimage_sha'] else b''): raise RuntimeError('final readback mismatch')
                (restored if touched else untouched).append(c)
            except Exception as e: errs.append(f'{c[:11]}: {e}')
    rec_ = {'run_id': prep['run_id'], 'at': ts(), 'state': 'ROLLED_BACK' if not errs else 'PARTIAL', 'reason': 'recover', 'restored': restored, 'untouched': untouched, 'errors': errs}
    atomic_write(os.path.join(rd, 'manifest.rolledback.json' if not errs else 'manifest.partial.json'), json.dumps(rec_, ensure_ascii=False, indent=1).encode())
    print(json.dumps(rec_, ensure_ascii=False)); sys.exit(0 if not errs else 3)
def opt(name):
    if name in a:
        i = a.index(name)
        if i + 1 >= len(a) or a[i + 1].startswith('--'): print(f'{name} needs a value', file=sys.stderr); sys.exit(2)
        return a[i + 1]
    return None
apply = '--apply' in a; norm = '--normalize-polluted' in a; only = opt('--chat'); auth = opt('--authorized-by'); plan_sha = opt('--plan-sha')
cand = set(cfg().get('finished_candidates', []))
def refuse(msg): print('REFUSED (zero writes): ' + msg, file=sys.stderr); sys.exit(2)
if only is not None and not (only.startswith('oc_') and len(only) > 11): refuse(f'--chat must be a full chat id, got {only!r}')
if norm and not only: refuse('--normalize-polluted requires --chat <single full chat id> (fleet-wide normalization is never authorized)')
if apply and not auth: refuse('--apply requires --authorized-by <verified owner open_id>')
if apply and not plan_sha: refuse('--apply requires --plan-sha <sha of the read-only plan for exactly this target set>')
if auth is not None and auth not in verified_owner_ids(): refuse(f'--authorized-by {auth!r} is not a verified owner in config.owners (verified_at required)')
INV = {'active': (1, 'on'), 'paused': (0, 'on'), 'finished': (0, 'off'), 'unmanaged': (0, 'on')}
def classify(st):
    ok, why = managed_state(st)
    if ok: return 'managed', why
    lc = st.get('lifecycle')
    if not isinstance(lc, dict): return 'legacy_no_lifecycle', why
    try: sv = int(st.get('schema_version') or 0)
    except Exception: sv = 0
    if sv < 4: return 'schema3_with_lifecycle', why
    if lifecycle_schema_errors(st): return 'invalid_lifecycle', why
    return 'schema4_no_provenance', why
ACTION = {'legacy_no_lifecycle': 'write lifecycle + schema 4 + provenance', 'schema4_no_provenance': 'wake readback + provenance(bootstrap_era)',
          'schema3_with_lifecycle': 'normalize: keep fields, wake readback, schema 4, paused-consistency, provenance(normalized_from=schema3_polluted)'}
def simulate(st, cls, act, c):
    """在内存里做与 apply 相同的规范化，返回 (post_state, post{status,cron,instant})；用于计划里的后置与 managed 预判。"""
    st = json.loads(json.dumps(st)); lc = lifecycle_of(st) if isinstance(st.get('lifecycle'), dict) else lifecycle_of(None)
    if cls == 'legacy_no_lifecycle' and c in cand:
        lc['status'] = 'unmanaged'; lc['candidate_since'] = ts(); inst = 'on'
        tpl = cron_template_for(c, st)
        if not tpl: raise RuntimeError('candidate needs config.cron_template (wake_backup.cron for unmanaged→active repair)')
        lc['wake_backup'] = {'cron': tpl, 'instant': 'on'}  # S3 r2：候选必须带可复活的 cron 模板，否则 unmanaged→active repair 无模板会失败并拖垮心跳
    else: inst = act['instant']
    lc['wake'] = {'cron': act['cron'][0] if act['cron'] else None, 'instant': inst}
    st['lifecycle'] = lc; st['schema_version'] = max(int(st.get('schema_version') or 0), 4); st['paused'] = (lc['status'] == 'finished')
    st['p5_managed'] = {'source': 'backfill', 'at': ts(), 'preimage_sha': 'x', 'from_class': cls, 'authorized_by': 'x', 'plan_sha': 'x', **({'normalized_from': 'schema3_polluted'} if cls == 'schema3_with_lifecycle' else {})}
    return st, {'status': lc['status'], 'cron': len(act['cron']), 'instant': inst}
def record(c):
    st = read_state(c)
    if not isinstance(st, dict) or st.get('chat_id') != c: return {'chat': c, 'class': 'REFUSED', 'action': f'REFUSED: state.chat_id {(st or {}).get("chat_id")!r} != {c!r} (exact full-id binding)'}
    cls, why = classify(st); rec = {'chat': c, 'class': cls, 'why': why}
    if cls == 'managed': return rec
    act = wake_actual(c); rec.update({'preimage_sha': sha256b(open(p_state(c), 'rb').read()), 'wake': act, 'candidate': c in cand})
    if cls == 'invalid_lifecycle': rec['action'] = 'REFUSED: lifecycle schema invalid (type/shape corruption); backfill does not repair it — owner decision'; return rec
    if cls == 'schema3_with_lifecycle' and not norm: rec['action'] = 'REFUSED: polluted state needs owner-authorized --chat <id> --normalize-polluted'; return rec
    post_st, post = simulate(st, cls, act, c); rec['post'] = post
    need = INV.get(post['status'])
    if not need: rec['action'] = f'REFUSED: lifecycle.status {post["status"]!r} not in enum'; return rec
    if cls == 'legacy_no_lifecycle' and c in cand and post['cron'] != 0: rec['action'] = 'REFUSED: finished candidate must have cron=0 (remove cron or drop from finished_candidates)'; return rec
    if not (cls == 'legacy_no_lifecycle' and c in cand) and (post['cron'], post['instant']) != need: rec['action'] = f'REFUSED: wake precondition for {post["status"]} is cron={need[0]}/instant={need[1]}, actual cron={post["cron"]}/instant={post["instant"]} (restore wake or add to finished_candidates first)'; return rec
    mok, mwhy = managed_state(post_st)
    if not mok: rec['action'] = f'REFUSED: would not be managed after migration ({mwhy})'; return rec
    rec['action'] = ACTION[cls]; return rec
targets = [only] if only else all_chats()
if only and not os.path.exists(p_state(only)): refuse(f'no state for {only}')
def build_plan():
    man = [record(c) for c in targets]
    plan_set = [{k: r.get(k) for k in ('chat', 'class', 'preimage_sha', 'wake', 'candidate', 'action', 'post')} for r in man if r['class'] != 'managed']
    return man, sha256b(canonical({'target': only or 'fleet', 'normalize_polluted': norm, 'finished_candidates': sorted(cand), 'plan': plan_set}).encode())
man, computed = build_plan()
refused = [r['chat'] for r in man if str(r.get('action', '')).startswith('REFUSED')]
print(json.dumps({'target': only or 'fleet', 'plan_sha': computed, 'normalize_polluted': norm, 'finished_candidates': sorted(cand), 'plan': man}, ensure_ascii=False, indent=1))
if refused: print(f'REFUSED {len(refused)} state(s) in target set ({[c[:11] for c in refused]}); nothing is written (no partial apply)', file=sys.stderr); sys.exit(2)
if not apply: sys.exit(0)
if plan_sha != computed: refuse(f'--plan-sha {plan_sha[:16]} != current read-only plan {computed[:16]} (state/wake/class drift or different target set); re-run dry-run and re-authorize')
todo = [r for r in man if r['class'] != 'managed']
if not todo: print('nothing to apply'); sys.exit(0)
def store_sha():
    return sha256b(open(p_schedules(), 'rb').read() + b'|' + open(p_policies(), 'rb').read())
def wake_ok_for(post, act):
    return len(act['cron']) == post['cron'] and act['instant'] == post['instant']
def fsync_dir(d):
    try: fd = os.open(d, os.O_RDONLY); os.fsync(fd); os.close(fd)
    except Exception: pass
def hook(name, **env):
    cmd = os.environ.get(name)
    if cmd: subprocess.run(cmd, shell=True, env=dict(os.environ, **{k: str(v) for k, v in env.items()}))
run_id = now().strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8]
bk = os.path.join(P5_HOME, 'cost-opt', 'backup', 'p5-backfill-' + run_id)
done = []  # (chat, preimage_bytes, instant_flipped)
def durable_partial(reason, errors):
    rec_ = {'run_id': run_id, 'at': ts(), 'state': 'PARTIAL', 'reason': reason, 'rollback_errors': errors, 'written': [c for c, _, _ in done], 'plan_sha': computed, 'authorized_by': auth}
    try: atomic_write(os.path.join(bk, 'manifest.partial.json'), json.dumps(rec_, ensure_ascii=False, indent=1).encode())
    except Exception as e: rec_['partial_manifest_error'] = str(e)
    for c, _, _ in done:
        try: ledger_line(c, f'⚠️ backfill run {run_id} 回滚失败，state/wake 可能处于 partial（需人工按 backup/p5-backfill-{run_id}/manifest.prepare.json 恢复）：{reason[:80]}')
        except Exception: pass
    print(json.dumps({'applied': [], 'partial': [c for c, _, _ in done], 'error': reason, 'rollback_errors': errors, 'run_dir': bk}, ensure_ascii=False))
    print(f'PARTIAL (rollback failed; state/wake may be half-migrated, manual recovery required): {reason}; see {bk}/manifest.partial.json', file=sys.stderr); sys.exit(3)
def rollback(reason):
    errs = []
    for c, pre, flipped in reversed(done):
        try:
            if os.environ.get('P5_FAULT') == 'rollback_fail': raise RuntimeError('injected rollback failure')
            atomic_write(p_state(c), pre)
            if open(p_state(c), 'rb').read() != pre: raise RuntimeError('preimage readback mismatch')
            if flipped:
                instant_set(c, False)
                if instant_state(c) != 'off': raise RuntimeError('instant un-flip readback mismatch')
        except Exception as e: errs.append(f'{c[:11]}: {e}')
    if errs: durable_partial(reason, errs)
    try: atomic_write(os.path.join(bk, 'manifest.rolledback.json'), json.dumps({'run_id': run_id, 'at': ts(), 'state': 'ROLLED_BACK', 'reason': reason, 'restored': [c for c, _, _ in done]}, ensure_ascii=False, indent=1).encode())
    except Exception as e: print(f'note: rolledback manifest not written: {e}', file=sys.stderr)
    print(json.dumps({'applied': [], 'rolled_back': [c for c, _, _ in done], 'error': reason, 'run_dir': bk}, ensure_ascii=False)); print('ROLLED BACK (net zero change, readback verified): ' + reason, file=sys.stderr); sys.exit(1)
with AuthLocks(*[r['chat'] for r in todo]):  # 按 chat 全序持有全部目标 state 锁
    man2, computed2 = build_plan()  # 锁内一次性重验：state 字节 / wake / class / post 与计划逐字一致
    if computed2 != computed: refuse('targets drifted between plan and locked preflight (state/wake/class); nothing written')
    base = store_sha()
    # ---- prepare manifest（durable，写前）----
    try:
        os.makedirs(bk, exist_ok=False)
        if os.environ.get('P5_FAULT') == 'manifest_prepare': raise RuntimeError('injected prepare failure')
        prep = {'run_id': run_id, 'at': ts(), 'state': 'PREPARED', 'authorized_by': auth, 'plan_sha': computed, 'target': only or 'fleet', 'normalize_polluted': norm, 'finished_candidates': sorted(cand), 'store_sha': base,
                'targets': [{'chat': r['chat'], 'class': r['class'], 'preimage_sha': r['preimage_sha'], 'wake': r['wake'], 'post': r['post'], 'candidate': r['candidate']} for r in todo]}
        atomic_write(os.path.join(bk, 'manifest.prepare.json'), json.dumps(prep, ensure_ascii=False, indent=1).encode())
        if json.load(open(os.path.join(bk, 'manifest.prepare.json')))['plan_sha'] != computed: raise RuntimeError('prepare manifest readback mismatch')
    except Exception as e: refuse(f'prepare manifest failed ({e}); nothing written')
    print(f'run_dir: {bk}', file=sys.stderr, flush=True)
    try:
        for i, rec in enumerate(todo):
            c = rec['chat']; cls = rec['class']
            hook('P5_TEST_HOOK_BACKFILL_BEFORE_WRITE', P5_BF_INDEX=i)  # 测试：build_plan 之后、第 i 个目标写前的并发漂移
            pre = open(p_state(c), 'rb').read()
            if sha256b(pre) != rec['preimage_sha']: raise RuntimeError(f'{c[:11]} preimage drifted under lock')
            if store_sha() != base: raise RuntimeError(f'{c[:11]} botmux store (schedules/policies) changed since locked plan')
            act = wake_actual(c)
            if canonical(act) != canonical(rec['wake']): raise RuntimeError(f'{c[:11]} wake drifted since locked plan: {act} != {rec["wake"]}')
            shutil.copy2(p_state(c), os.path.join(bk, os.path.basename(p_state(c))))
            if open(os.path.join(bk, os.path.basename(p_state(c))), 'rb').read() != pre: raise RuntimeError(f'{c[:11]} preimage backup readback mismatch')
            st = read_state(c); lc = lifecycle_of(st) if isinstance(st.get('lifecycle'), dict) else lifecycle_of(None); flipped = False
            is_cand = cls == 'legacy_no_lifecycle' and c in cand; will_flip = is_cand and act['instant'] != 'on'
            # r14 P1-2 phase WAL：任何外写之前先 durable 落 intent（含是否要翻 instant、wake 前像）
            append_fsync(os.path.join(bk, 'progress.jsonl'), {'phase': 'intent', 'chat': c, 'at': ts(), 'preimage_sha': rec['preimage_sha'], 'flip_intended': will_flip, 'wake_pre': act})
            if os.environ.get('P5_FAULT') == 'crash_after_intent' and is_cand: os._exit(73)  # intent 已落盘、动作未做
            if is_cand:
                if will_flip:
                    sched_before = open(p_schedules(), 'rb').read(); pol_before = load_policies()
                    instant_set(c, True, prompt=instant_prompt_for(c)); flipped = True; done.append((c, pre, flipped))
                    if os.environ.get('P5_FAULT') == 'crash_after_flip' and is_cand: os._exit(72)
                    # r14 P1-1：不盲刷基线——证明 store 变化只来自本目标的 instantObserver：schedules 字节不变；policies 除本 chat 条目外逐字相同；本 chat 条目仅 instantObserver 变化
                    sched_after_b = open(p_schedules(), 'rb').read(); pol_after_b = open(p_policies(), 'rb').read(); pol_after = json.loads(pol_after_b.decode('utf-8'))  # 只读一次：验证与新基线都来自同一份字节
                    if sched_after_b != sched_before: raise RuntimeError(f'{c[:11]} schedules changed during instant_set (foreign store write)')
                    others_b = [e for e in pol_before.get('policies', []) if e.get('chatId') != c]; others_a = [e for e in pol_after.get('policies', []) if e.get('chatId') != c]
                    if canonical(others_b) != canonical(others_a) or canonical({k: v for k, v in pol_before.items() if k != 'policies'}) != canonical({k: v for k, v in pol_after.items() if k != 'policies'}): raise RuntimeError(f'{c[:11]} policies changed beyond this chat during instant_set (foreign store write)')
                    mine_b = [e for e in pol_before.get('policies', []) if e.get('chatId') == c]; mine_a = [e for e in pol_after.get('policies', []) if e.get('chatId') == c]
                    # 本 chat 条目：只允许 instantObserver 与 updatedAt 变化；条目原本不存在时只允许 botmux setPolicy 的 defaultPolicy 形态（chatId/driveOn=false/reportTargetChatId=null/scoutMode）
                    POL_VOL = ('instantObserver', 'updatedAt'); strip_ = lambda e: {k: v for k, v in e.items() if k not in POL_VOL}
                    if len(mine_a) != 1: raise RuntimeError(f'{c[:11]} own policy entry count {len(mine_a)} != 1 after instant_set')
                    if mine_b:
                        if canonical(strip_(mine_a[0])) != canonical(strip_(mine_b[0])): raise RuntimeError(f'{c[:11]} own policy entry changed beyond instantObserver/updatedAt')
                    else:
                        fresh = strip_(mine_a[0])
                        if set(fresh) - {'chatId', 'driveOn', 'reportTargetChatId', 'scoutMode'} or fresh.get('chatId') != c or fresh.get('driveOn') not in (False, None) or fresh.get('reportTargetChatId') is not None or not isinstance(fresh.get('scoutMode', 'watch'), str): raise RuntimeError(f'{c[:11]} fresh policy entry is not botmux defaultPolicy shape: {fresh}')
                    if not (isinstance(mine_a[0].get('instantObserver'), dict) and mine_a[0]['instantObserver'].get('enabled') is True and mine_a[0]['instantObserver'].get('larkAppId') == observer_app()): raise RuntimeError(f'{c[:11]} instantObserver not written as expected: {mine_a[0].get("instantObserver")}')
                    append_fsync(os.path.join(bk, 'progress.jsonl'), {'phase': 'instant_flipped', 'chat': c, 'at': ts(), 'policy_post': mine_a[0].get('instantObserver')})  # S3 r3：记录本次写入的精确 policy postimage
                    hook('P5_TEST_HOOK_BACKFILL_AFTER_FLIP', P5_BF_INDEX=i)  # 测试：instant_flipped 落盘后、基线形成前的并发 store 写窗口
                    base = sha256b(sched_before + b'|' + pol_after_b)  # r15 P1-1：新基线 = 已验证的确定性 postimage 字节，绝不重新盲读当前 store；窗口内任何外写都会在下一次 CAS 失配
                if instant_state(c) != 'on':
                    if not flipped: done.append((c, pre, flipped))
                    raise RuntimeError(f'{c[:11]} instant readback not on; unmanaged NOT written')
                lc['status'] = 'unmanaged'; lc['candidate_since'] = ts(); lc['wake_backup'] = {'cron': cron_template_for(c, st), 'instant': 'on'}; act = wake_actual(c)  # 候选初态 unmanaged + 可复活 cron 模板
            if not wake_ok_for(rec['post'], act):
                if not flipped: done.append((c, pre, flipped))
                raise RuntimeError(f'{c[:11]} wake does not satisfy target post {rec["post"]}: {act}')
            lc['wake'] = {'cron': act['cron'][0] if act['cron'] else None, 'instant': act['instant']}
            st['lifecycle'] = lc; st['schema_version'] = max(int(st.get('schema_version') or 0), 4); st['paused'] = (lc['status'] == 'finished')
            st['p5_managed'] = {'source': 'backfill', 'at': ts(), 'preimage_sha': rec['preimage_sha'], 'from_class': cls, 'authorized_by': auth, 'plan_sha': computed, 'run_id': run_id, **({'normalized_from': 'schema3_polluted'} if cls == 'schema3_with_lifecycle' else {})}
            write_state(c, st)
            if not flipped: done.append((c, pre, flipped))
            rec['applied'] = True
            if os.environ.get('P5_FAULT') == 'crash_before_progress' and i == 0: os._exit(71)  # state 已迁移、state_written 记录未落
            append_fsync(os.path.join(bk, 'progress.jsonl'), {'phase': 'state_written', 'chat': c, 'written_at': ts(), 'instant_flipped': flipped, 'preimage_sha': rec['preimage_sha'], 'post_owned': owned_fields(st), 'post_sha': sha256b(open(p_state(c), 'rb').read()), 'post_lifecycle_sha': lifecycle_hashes(read_state(c))[0], 'repairs_lines': len(read_jsonl(p_repairs(c))) if os.path.exists(p_repairs(c)) else 0, 'journal_seq': journal_head_seq(c)})  # S3 r3：精确 postimage（P5 自有字段）
            if os.environ.get('P5_FAULT') == 'crash_after_first' and len(done) == 1: os._exit(70)
            if os.environ.get('P5_FAULT') == 'backfill_after_first' and len(done) == 1: raise RuntimeError('injected failure after first target')
            rec['managed_after'], rec['managed_why'] = managed_state(read_state(c))
            if not rec['managed_after']: raise RuntimeError(f'{c[:11]} not managed after write: {rec["managed_why"]}')
            hook('P5_TEST_HOOK_BACKFILL_AFTER_WRITE', P5_BF_INDEX=i)
        # ---- fleet post-readback（实物 wake 满足目标不变式 + managed + store CAS）----
        if store_sha() != base: raise RuntimeError('botmux store changed during apply (post-readback CAS)')
        for rec in todo:
            c = rec['chat']; act = wake_actual(c); st = read_state(c)
            if not wake_ok_for(rec['post'], act): raise RuntimeError(f'{c[:11]} post-readback wake {act} violates target post {rec["post"]}')
            if not managed_state(st)[0] or (st.get('p5_managed') or {}).get('run_id') != run_id: raise RuntimeError(f'{c[:11]} post-readback state not this run\'s managed image')
            werrs = validate_wake_entries(c)
            if werrs: raise RuntimeError(f'{c[:11]} wake entries invalid before commit: {werrs}')  # r15 P1-1：policy 唯一性 / app 绑定 / cron 字段齐全，抽象层之下的坏实物也不得提交
            committed = st['lifecycle']['wake']; expect = {'cron': [committed['cron']] if committed.get('cron') else [], 'instant': committed.get('instant')}
            if canonical(act) != canonical(expect): raise RuntimeError(f'{c[:11]} post-readback wake (full fields) != committed lifecycle.wake: {act} vs {expect}')  # r14 P1-1：逐字核 9 字段 cron + instant，不只数量
            if INV[st['lifecycle']['status']] != (len(act['cron']), act['instant']): raise RuntimeError(f'{c[:11]} status/wake invariant broken after write')
        # ---- commit manifest（同一事务内；失败即回滚）----
        if os.environ.get('P5_FAULT') == 'manifest_commit': raise RuntimeError('injected manifest commit failure')
        manifest = dict(prep, state='COMMITTED', committed_at=ts(), records=man)
        mp = os.path.join(bk, 'manifest.json'); atomic_write(mp, json.dumps(manifest, ensure_ascii=False, indent=1).encode()); fsync_dir(bk)
        rb = json.load(open(mp))
        if rb.get('state') != 'COMMITTED' or rb.get('plan_sha') != computed or rb.get('run_id') != run_id: raise RuntimeError('manifest commit readback mismatch')
    except SystemExit: raise
    except Exception as e: rollback(str(e))
print('backup+manifest:', bk)
print(json.dumps({'applied': [r['chat'] for r in todo], 'failed': [], 'run_dir': bk, 'run_id': run_id}, ensure_ascii=False)); sys.exit(0)
