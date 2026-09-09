#!/usr/bin/env python3
"""p5-rollout-rollback.py <run_dir>... [--apply] [--no-timer] [--keep-config]
S3 committed-rollout 回退（与 --recover 互补：--recover 只处理未 COMMITTED 的崩溃 run；本工具回退已 COMMITTED 的 backfill run 目标）。
r3 语义（真正的 postimage/ownership CAS，任一不成立 → 整次 rc 2 零写）：
  state  ：只逆向 P5 自有字段（lifecycle / p5_managed / schema_version / paused），业务字段（tasks/notes/logs/updated_at…）保留当前值。
           CAS：当前自有字段 == 本 run 记录的精确 postimage（progress.state_written.post_owned；旧 run 无记录时用 prepare 里的确定性后置重算，时间戳字段以外逐字比对），
           lifecycle 允许 P5 簿记后继（wake_checked_at/children_seen/decisions/bubbles/asks）变化；status/generation/wake/wake_backup 等转换字段必须逐字等于 postimage。
  cron   ：只删本 run 之后由 P5 自己加的 observer cron：id ∈ wake-registry 且能在本群 repairs/journal 的 committed 事务 action_done receipt 里找到（run 提交之后），
           且当前条目与 receipt 里的完整后像（entry9：name/prompt/chatId/larkAppId/executionPosition/silent/enabled/workingDir/scope + id + schedule + prompt_sha）逐字段相等（r5）；
           同 id 内容漂移（别的写者改了 prompt/schedule/…）或证明不了归属 → 整次拒绝（不猜）。删除计划里放的是 receipt 后像，apply 时再 CAS 一次。
  policy ：instant 只关回本 run 写入的精确 postimage（progress.instant_flipped.policy_post；旧 run 用 config 推导：enabled/observer_app/90/标准 prompt）；条目 instantObserver 与之逐字不等 → 拒绝。
r4：state 后继校验 = journal hash 链（每条 lifecycle_write 记录 pre/post sha 逐段衔接，事务段须与 plan/repair 的 intent/state_committed/postimage sha 一致，非事务段只许簿记）；
    --apply 先持全部目标 ChatLock（按 chat 排序）→ 锁内重做全量预检（最终 CAS）→ 任一拒绝 rc 2 且 config/timer/cron/policy/state 均未写 → config 切 dry-run（先备份）→ 停 timer（--no-timer 跳过）
    → 逐目标 cron CAS 删 / policy CAS 关 / state 精确字节 sha CAS 后只覆写自有字段 → 读回 → manifest.rollout-rolledback.json。exit：0 完成；1 执行中失败（manifest.rollout-partial.*.json）；2 预检拒绝零写。"""
import sys, os, json, subprocess, datetime; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
a = sys.argv[1:]; apply = '--apply' in a; no_timer = '--no-timer' in a; keep_cfg = '--keep-config' in a
runs = [x for x in a if not x.startswith('--')]
def refuse(msg): print('REFUSED (zero writes): ' + msg, file=sys.stderr); sys.exit(2)
if not runs: refuse('usage: p5-rollout-rollback.py <run_dir>... [--apply] [--no-timer] [--keep-config]')
TS_KEYS = ('at', 'candidate_since', 'status_changed_at')
def norm_owned(o):
    """postimage 比对口径：lifecycle 去簿记、去时间戳；p5_managed 去 at。"""
    o = json.loads(json.dumps(o)); lc = o.get('lifecycle')
    if isinstance(lc, dict):
        lc = bookkeeping_masked(lc)
        for k in TS_KEYS: lc.pop(k, None)
        o['lifecycle'] = lc
    pm = o.get('p5_managed')
    if isinstance(pm, dict): o['p5_managed'] = {k: v for k, v in pm.items() if k != 'at'}
    return o
def derive_post_owned(prep, t, pre_state):
    """旧 run（无 post_owned 记录）：按 prepare 的确定性后置重算自有字段。"""
    st = json.loads(json.dumps(pre_state)); lc = lifecycle_of(st) if isinstance(st.get('lifecycle'), dict) else lifecycle_of(None)
    if t.get('candidate') and t['class'] == 'legacy_no_lifecycle':
        lc['status'] = 'unmanaged'; lc['wake_backup'] = {'cron': cron_template_for(t['chat'], st), 'instant': 'on'}; inst = 'on'
    else: inst = t['wake']['instant']
    lc['wake'] = {'cron': t['wake']['cron'][0] if t['wake']['cron'] else None, 'instant': inst}
    pm = {'source': 'backfill', 'preimage_sha': t['preimage_sha'], 'from_class': t['class'], 'authorized_by': prep['authorized_by'], 'plan_sha': prep['plan_sha'], 'run_id': prep['run_id'], **({'normalized_from': 'schema3_polluted'} if t['class'] == 'schema3_with_lifecycle' else {})}
    return {'lifecycle': lc, 'p5_managed': pm, 'schema_version': max(int(st.get('schema_version') or 0), 4), 'paused': lc['status'] == 'finished'}
def p5_added_crons(chat, cut):
    """本群 run 之后 **committed** P5 事务（repairs + plan journal）action_done receipt 里的完整 cron 后像：{id: entry9}（r5：删除基线 = receipt 后像，不是当前条目）。
    同一 id 多笔 receipt 时取最后一笔（后一笔事务的 receipt 即当时读回的实况）。"""
    out = {}
    for tx in committed_txs(chat, cut):
        for e in tx['cron_entries']: out[e.get('id')] = e
    return out
def rows_after(chat, cut):
    """run 提交之后的 repairs/journal 记录：cut 有精确游标（state_written 记录的 repairs 行数 / journal seq）用位置切；旧 run 退化为 at >= committed_at。"""
    rep = read_jsonl(p_repairs(chat)) if os.path.exists(p_repairs(chat)) else []; jn = journal(chat)
    if cut.get('repairs_lines') is not None and cut.get('journal_seq') is not None:
        return rep[cut['repairs_lines']:], [r for r in jn if (r.get('seq') or 0) > cut['journal_seq']]
    since = cut.get('since') or ''
    return [r for r in rep if (r.get('at') or '') >= since], [r for r in jn if (r.get('at') or '') >= since]
def committed_txs(chat, cut):
    """本群 run 提交之后、P5 自己 committed 的事务（repairs + plan journal），按 intent 时间排序：
    每项 {key, kind, pre_gen, post_gen, postimage(lifecycle 全量, state_write_intent), cron_ids(action_done receipt)}。"""
    groups = {}; rep, jn = rows_after(chat, cut)
    for r in rep:
        if r.get('repair_key'): groups.setdefault(('repair', r['repair_key']), []).append(r)
    for r in jn:
        if r.get('kind') == 'plan' and r.get('plan_sha'): groups.setdefault(('plan', r['plan_sha']), []).append(r)
    out = []
    for (kind, key), rows in groups.items():
        ph = {r.get('phase'): r for r in rows}
        if 'intent' not in ph or 'committed' not in ph or 'state_committed' not in ph or 'state_write_intent' not in ph: continue
        out.append({'key': key, 'kind': kind, 'at': ph['intent'].get('at'), 'pre_gen': ph['intent']['payload']['preimage']['generation'], 'pre_sha': ph['intent']['payload']['preimage']['lifecycle_sha'],
                    'post_gen': ph['state_committed']['payload']['generation'], 'post_sha': ph['state_committed']['payload']['lifecycle_sha'], 'postimage': ph['state_write_intent']['payload']['postimage'],
                    'cron_ids': [c.get('id') for c in ((ph.get('action_done') or {}).get('payload', {}).get('receipt') or {}).get('cron') or []],
                    'cron_entries': [entry9(c) for c in ((ph.get('action_done') or {}).get('payload', {}).get('receipt') or {}).get('cron') or []]})
    return sorted(out, key=lambda x: (x['at'] or '', x['post_gen']))
def lineage_check(chat, head_sha, post_owned, cur_state, cut, legacy_heads=None, legacy_masked=None):
    """S3 r4 hash 链校验（每段验前像 hash / 后像 hash / state_committed hash / 连续性）：
      journal 里 run 之后的每条 kind=lifecycle_write 记录必须 pre_sha == 链头，链头推进为 post_sha；链尾必须 == 当前 lifecycle 精确 sha。
      非事务的 lifecycle_write 只允许簿记（pre_masked == post_masked）；committed 事务（plan/repair）必须 lifecycle_sha(postimage) == state_committed.lifecycle_sha == 链上某段的 post_sha 且其 pre_sha == 该段 pre_sha。
      head_sha 未知（旧 run）时：用 legacy_heads（按 prepare 推导的候选精确后像 sha 集合）中能与链首/当前 sha 对上的那个作为链头，对不上 → 断链。
    返回 (ok, expected_owned, txs, why, info)。"""
    rep, jn = rows_after(chat, cut); writes = [r for r in jn if r.get('kind') == 'lifecycle_write']
    txs = committed_txs(chat, cut); cur_sha, _ = lifecycle_hashes(cur_state); info = {'chain_len': len(writes), 'head': head_sha}
    if head_sha is None:  # 旧 run（r4 之前提交，progress 无 post_lifecycle_sha）：链头只能由 prepare 推导
        first, first_m = (writes[0]['pre_sha'], writes[0].get('pre_masked')) if writes else lifecycle_hashes(cur_state)
        if legacy_heads and first in legacy_heads: head_sha = first; info.update(head=head_sha, head_source='legacy-derived-exact', head_exact=True)
        elif legacy_masked and first_m == legacy_masked: head_sha = first; info.update(head=head_sha, head_source='legacy-masked-match', head_exact=False, note='pre-journaling bookkeeping (e.g. wake_checked_at) on the head is unverifiable for legacy runs; all non-bookkeeping/non-timestamp fields verified by hash')
        else: return False, post_owned, txs, f'lineage head unverifiable: legacy run postimage not derivable to match chain head {str(first)[:12]} (exact nor masked)', info
    h = head_sha
    for i, w in enumerate(writes):
        if w.get('pre_sha') != h: return False, post_owned, txs, f'hash chain broken at journal seq {w.get("seq")}: pre_sha {str(w.get("pre_sha"))[:12]} != head {str(h)[:12]} (unjournaled write in between)', info
        h = w.get('post_sha')
    if h != cur_sha: return False, post_owned, txs, f'hash chain tail {str(h)[:12]} != current lifecycle sha {str(cur_sha)[:12]} (unjournaled write after last record)', info
    segs = {(w.get('pre_sha'), w.get('post_sha')): w for w in writes}
    exp = json.loads(json.dumps(post_owned)); gen = ((exp.get('lifecycle') or {}).get('status_generation')); hh = head_sha; tx_segs = set()
    for tx in txs:
        if tx['pre_gen'] != gen: return False, exp, txs, f"tx {tx['kind']}:{tx['key'][:16]} preimage generation {tx['pre_gen']} != lineage head generation {gen}", info
        if lifecycle_sha(tx['postimage']) != tx['post_sha']: return False, exp, txs, f"tx {tx['kind']}:{tx['key'][:16]} state_committed.lifecycle_sha != sha(state_write_intent.postimage)", info
        if (tx['pre_sha'], tx['post_sha']) not in segs: return False, exp, txs, f"tx {tx['kind']}:{tx['key'][:16]} (pre {tx['pre_sha'][:12]} -> post {tx['post_sha'][:12]}) has no matching lifecycle_write segment in hash chain", info
        tx_segs.add((tx['pre_sha'], tx['post_sha'])); exp['lifecycle'] = tx['postimage']; exp['paused'] = (tx['postimage'].get('status') == 'finished'); gen = tx['post_gen']
    for w in writes:
        if (w.get('pre_sha'), w.get('post_sha')) in tx_segs: continue
        if w.get('pre_masked') != w.get('post_masked'): return False, exp, txs, f'non-transactional lifecycle write at journal seq {w.get("seq")} (writer {w.get("writer")}) changed non-bookkeeping fields', info
    cur_owned = owned_fields(cur_state)
    if norm_owned(cur_owned) != norm_owned(exp): return False, exp, txs, 'owned fields != expected (postimage / last committed tx postimage) after masking bookkeeping', info
    return True, exp, txs, '', info
def legacy_head_candidates(prep, t, pre_state, written_at):
    """旧 run 精确后像 sha 候选：candidate_since = ts() 落在 written_at ±5s；非候选类 lifecycle 无新时间戳 → 单一候选。"""
    base = derive_post_owned(prep, t, pre_state)['lifecycle']; out = set()
    if not (t.get('candidate') and t['class'] == 'legacy_no_lifecycle'): return {lifecycle_sha(lifecycle_of({'lifecycle': base}))}
    try: w = datetime.datetime.strptime(written_at, '%Y-%m-%d %H:%M:%S')
    except Exception: return set()
    for d in range(-5, 6):
        lc = json.loads(json.dumps(base)); lc['candidate_since'] = (w + datetime.timedelta(seconds=d)).strftime('%Y-%m-%d %H:%M:%S'); out.add(lifecycle_sha(lifecycle_of({'lifecycle': lc})))
    return out
SKIPPED = []
def preflight():
    """只读预检（--apply 时在全部目标锁内再跑一遍，作为最终全量 CAS）。返回 plan 列表；每项含 locked 快照 state_sha/policy_entry。"""
    plan = []
    for rd in runs:
        mp = os.path.join(rd, 'manifest.json'); pp = os.path.join(rd, 'manifest.prepare.json')
        if not os.path.isfile(mp) or not os.path.isfile(pp): refuse(f'{rd}: not a COMMITTED backfill run (manifest.json + manifest.prepare.json required)')
        man = json.load(open(mp)); prep = json.load(open(pp))
        if man.get('state') != 'COMMITTED' or man.get('run_id') != prep.get('run_id'): refuse(f'{rd}: manifest not COMMITTED or run_id mismatch')
        if os.path.isfile(os.path.join(rd, 'manifest.rollout-rolledback.json')): SKIPPED.append(rd); continue
        prog = read_jsonl(os.path.join(rd, 'progress.jsonl')) if os.path.exists(os.path.join(rd, 'progress.jsonl')) else []
        for t in prep['targets']:
            c = t['chat']; item = {'run_dir': rd, 'run_id': prep['run_id'], 'chat': c, 'actions': [], 'refuse': []}
            st = read_state(c); cur_b = open(p_state(c), 'rb').read(); cur_sha = sha256b(cur_b); item['state_sha'] = cur_sha
            bkf = os.path.join(rd, os.path.basename(p_state(c)))
            if not os.path.isfile(bkf) or sha256b(open(bkf, 'rb').read()) != t['preimage_sha']: item['refuse'].append('preimage backup missing or sha mismatch'); plan.append(item); continue
            pre_state = json.loads(open(bkf, 'rb').read().decode('utf-8'))
            sw = [p for p in prog if p.get('phase') == 'state_written' and p.get('chat') == c]
            rec = bool(sw and sw[-1].get('post_owned')); post_owned = sw[-1]['post_owned'] if rec else derive_post_owned(prep, t, pre_state); item['postimage_source'] = 'recorded' if rec else 'derived-from-prepare'
            head = sw[-1].get('post_lifecycle_sha') if sw else None
            since = man.get('committed_at') or prep.get('at') or ''
            cut = {'since': since, 'repairs_lines': (sw[-1].get('repairs_lines') if sw else None), 'journal_seq': (sw[-1].get('journal_seq') if sw else None)}; item['lineage_cursor'] = 'recorded' if cut['repairs_lines'] is not None else 'committed_at'
            legacy = legacy_head_candidates(prep, t, pre_state, (sw[-1].get('written_at') if sw else None) or man.get('committed_at') or '') if head is None else None
            legacy_m = lifecycle_hashes({'lifecycle': post_owned.get('lifecycle')})[1] if head is None else None
            ok, expected, txs, why, info = lineage_check(c, head, post_owned, st, cut, legacy, legacy_m); item['lineage'] = info
            item['successors'] = [{'kind': x['kind'], 'key': x['key'][:16], 'at': x['at'], 'gen': f"{x['pre_gen']}->{x['post_gen']}", 'status': x['postimage'].get('status'), 'cron_ids': x['cron_ids']} for x in txs]
            if cur_sha == t['preimage_sha']: item['state'] = 'already-preimage'
            elif ok: item['state'] = 'revert-owned-fields'; item['actions'].append(f'state: revert lifecycle/p5_managed/schema_version/paused to preimage (business fields kept; hash chain {info["chain_len"]} segments, {len(txs)} committed tx; exact CAS on state bytes {cur_sha[:12]} at apply)')
            else:
                cur_owned = owned_fields(st); diff = [k for k in OWNED_KEYS if norm_owned({k: cur_owned.get(k)}) != norm_owned({k: expected.get(k)})]
                a, b_ = norm_owned(cur_owned).get('lifecycle') or {}, norm_owned(expected).get('lifecycle') or {}
                sub = sorted(k for k in set(a) | set(b_) if a.get(k) != b_.get(k)) if 'lifecycle' in diff else []
                item['refuse'].append(f'state owned fields != this run postimage/journal successor ({why}{"; differs in " + str(diff) if diff else ""}{" lifecycle." + ",".join(sub) if sub else ""}); manual decision'); item['owned_diff'] = {'cur': {k: a.get(k) for k in sub}, 'expected': {k: b_.get(k) for k in sub}}
            act = wake_actual(c); pre_ids = {e.get('id') for e in t['wake']['cron']}; extra = [e for e in act['cron'] if e.get('id') not in pre_ids]; missing = pre_ids - {e.get('id') for e in act['cron']}
            reg = set(registered_wake_ids(c)); owned = p5_added_crons(c, cut); item['cron_remove'] = []; unproven = []; drifted = []
            for e in extra:  # r5：删除基线 = committed 事务 receipt 里的完整后像；当前条目须与后像逐字段（entry9：9 字段 + id + schedule + prompt_sha）相等
                sid = e.get('id'); post = owned.get(sid)
                if not (sid in reg and post is not None): unproven.append(sid); continue
                cur9 = entry9(e); diff = sorted(k for k in set(cur9) | set(post) if cur9.get(k) != post.get(k))
                if diff: drifted.append({'id': sid, 'fields': diff, 'receipt': {k: post.get(k) for k in diff}, 'current': {k: cur9.get(k) for k in diff}}); continue
                item['cron_remove'].append(post); item['actions'].append(f'schedule remove {sid} (P5-owned: registry + committed receipt after run; current entry == receipt postimage field-by-field; CAS again at apply)')
            if unproven: item['refuse'].append(f'observer cron {unproven} not in prepare and ownership unproven (registry+committed receipt required); manual decision')
            if drifted: item['refuse'].append(f'P5-owned cron content drifted since receipt postimage (foreign edit of same id): {drifted}; manual decision'); item['cron_drift'] = drifted
            if missing: item['refuse'].append(f'prepare cron ids {sorted(missing)} no longer present; manual decision')
            pol = [e for e in load_policies().get('policies', []) if e.get('chatId') == c]; io = (pol[0].get('instantObserver') if pol else None)
            pre_inst = t['wake']['instant']; cur_inst = act['instant']; item['instant'] = {'pre': pre_inst, 'cur': cur_inst}
            if cur_inst != pre_inst:
                fl = [p for p in prog if p.get('phase') == 'instant_flipped' and p.get('chat') == c]
                expected_pol = fl[-1].get('policy_post') if fl and fl[-1].get('policy_post') else {'enabled': True, 'larkAppId': observer_app(), 'debounceSeconds': 90, 'prompt': instant_prompt_for(c)}
                item['policy_source'] = 'recorded' if (fl and fl[-1].get('policy_post')) else 'derived-from-config'
                if pre_inst == 'off' and cur_inst == 'on' and io == expected_pol: item['actions'].append('watch set --instant off (CAS instantObserver == this run postimage)'); item['policy_cas'] = pol[0]
                else: item['refuse'].append(f'instant {cur_inst} != prepare {pre_inst} but instantObserver != this run postimage ({io} vs {expected_pol}); manual decision')
            plan.append(item)
    return plan
def report(plan):
    print(json.dumps({'apply': apply, 'plan': plan, 'skipped': SKIPPED}, ensure_ascii=False, indent=1))
    for rd in SKIPPED: print(f'{rd}: already rolled back; skipping')
    bad = [(i['chat'][:11], i['refuse']) for i in plan if i['refuse']]
    if bad: refuse(f'preflight failed for {bad}; nothing written')
if not apply:
    report(preflight()); print('dry-run only'); sys.exit(0)
# ---- --apply：先持全部目标锁（按 chat 排序），锁内重做全量预检 = 最终 CAS；任一拒绝 → rc 2，config/timer/cron/policy/state 均未写 ----
targets_all = sorted({t['chat'] for rd in runs if os.path.isfile(os.path.join(rd, 'manifest.prepare.json')) for t in json.load(open(os.path.join(rd, 'manifest.prepare.json')))['targets']})
import contextlib
with contextlib.ExitStack() as stack:
    for c in targets_all: stack.enter_context(ChatLock(c))
    plan = preflight(); report(plan)
    if not plan: print('nothing to roll back'); sys.exit(0)
    ts_ = now().strftime('%Y%m%dT%H%M%S'); results = []
    def fail(msg):
        for rd in {i['run_dir'] for i in plan}: atomic_write(os.path.join(rd, f'manifest.rollout-partial.{ts_}.json'), json.dumps({'at': ts(), 'state': 'PARTIAL', 'error': msg, 'results': results}, ensure_ascii=False, indent=1).encode())
        print('ROLLBACK FAILED (partial; see manifest.rollout-partial.*.json): ' + msg, file=sys.stderr); sys.exit(1)
    if not keep_cfg:
        cfgp = os.environ.get('P5_CONFIG') or CONFIG_PATH; cfg_ = json.load(open(cfgp)); bk = cfgp + f'.rollback-pre-{ts_}'; atomic_write(bk, open(cfgp, 'rb').read())
        targets = {i['chat'] for i in plan}; cfg_['mode'] = 'dry-run'; cfg_['apply_groups'] = [g for g in cfg_.get('apply_groups', []) if g not in targets]
        atomic_write(cfgp, json.dumps(cfg_, ensure_ascii=False, indent=1).encode()); rb = json.load(open(cfgp))
        if rb['mode'] != 'dry-run' or set(rb['apply_groups']) & targets: fail('config readback mismatch')
        results.append({'step': 'config', 'backup': bk, 'mode': rb['mode'], 'apply_groups': rb['apply_groups']})
    if not no_timer:
        r1 = subprocess.run(['systemctl', '--user', 'disable', '--now', 'p5-repair.timer'], capture_output=True, text=True); r2 = subprocess.run(['systemctl', '--user', 'stop', 'p5-repair.service'], capture_output=True, text=True)
        act_ = subprocess.run(['systemctl', '--user', 'is-active', 'p5-repair.timer'], capture_output=True, text=True).stdout.strip()
        if act_ == 'active': fail('timer still active after disable')
        results.append({'step': 'timer', 'disable_rc': r1.returncode, 'stop_rc': r2.returncode, 'timer_is_active': act_})
    for i in plan:
        c = i['chat']; rd = i['run_dir']; t = [x for x in json.load(open(os.path.join(rd, 'manifest.prepare.json')))['targets'] if x['chat'] == c][0]
        res = {'chat': c, 'before': {'wake': wake_actual(c), 'state_sha': sha256b(open(p_state(c), 'rb').read())}}
        for e in i['cron_remove']:  # e = receipt 后像（不是当前条目）；apply 时再次逐字段 CAS 当前 vs 后像
            cur = [x for x in wake_actual(c)['cron'] if x.get('id') == e['id']]
            if not cur or canonical(entry9(cur[0])) != canonical(e): fail(f'{c[:11]} cron {e["id"]} CAS mismatch at apply (current != receipt postimage)')
            schedule_remove(e['id'])
            if any(x.get('id') == e['id'] for x in wake_actual(c)['cron']): fail(f'{c[:11]} cron {e["id"]} still present after remove')
        if 'policy_cas' in i:
            pol = [x for x in load_policies().get('policies', []) if x.get('chatId') == c]
            if not pol or canonical(pol[0]) != canonical(i['policy_cas']): fail(f'{c[:11]} policy entry CAS mismatch at apply')
            instant_set(c, False)
            if instant_state(c) != 'off': fail(f'{c[:11]} instant readback not off')
        if i['state'] == 'revert-owned-fields':
            cur_b = open(p_state(c), 'rb').read()
            if sha256b(cur_b) != i['state_sha']: fail(f'{c[:11]} state bytes changed since locked preflight (exact CAS {i["state_sha"][:12]} != {sha256b(cur_b)[:12]})')
            st = json.loads(cur_b.decode('utf-8')); pre_state = json.loads(open(os.path.join(rd, os.path.basename(p_state(c))), 'rb').read().decode('utf-8'))
            keep = {k: v for k, v in st.items() if k not in OWNED_KEYS}  # 业务字段保留当前值
            for k in OWNED_KEYS:
                if k in pre_state: keep[k] = pre_state[k]
            write_state(c, keep)  # 经统一落盘口：lifecycle 变化会记 lifecycle_write（writer=本工具）
            rb_ = read_state(c)
            if owned_fields(rb_) != owned_fields(pre_state) or {k: v for k, v in rb_.items() if k not in OWNED_KEYS} != {k: v for k, v in st.items() if k not in OWNED_KEYS}: fail(f'{c[:11]} state readback: owned != preimage or business fields changed')
        cur_st = read_state(c); pre_state = json.loads(open(os.path.join(rd, os.path.basename(p_state(c))), 'rb').read().decode('utf-8'))
        res['after'] = {'wake': wake_actual(c), 'owned_is_preimage': owned_fields(cur_st) == owned_fields(pre_state), 'instant_is_pre': wake_actual(c)['instant'] == t['wake']['instant'], 'cron_ids_is_pre': {e.get('id') for e in wake_actual(c)['cron']} == {e.get('id') for e in t['wake']['cron']}}
        if not all(res['after'][k] for k in ('owned_is_preimage', 'instant_is_pre', 'cron_ids_is_pre')): fail(f'{c[:11]} final readback not equal to prepare preimage: {res["after"]}')
        results.append(res)
    for rd in {i['run_dir'] for i in plan}:
        atomic_write(os.path.join(rd, 'manifest.rollout-rolledback.json'), json.dumps({'at': ts(), 'state': 'ROLLOUT_ROLLED_BACK', 'results': results}, ensure_ascii=False, indent=1).encode())
    print(json.dumps({'rolled_back': [r['chat'] for r in results if 'chat' in r], 'steps': [r for r in results if 'step' in r]}, ensure_ascii=False)); sys.exit(0)
