#!/usr/bin/env python3
"""P5 核心：evaluate / plan / apply(硬门+WAL+补偿+恢复) / repair / audit / heartbeat（基线 P5-design-v7.md）。"""
import os, sys, json, datetime, uuid, re
from p5lib import *
import p5lib as L

class GateFail(Exception): pass
def quarantine_inflight_plan(chat, sha, why, log):
    """r11 P1-1：在途 plan WAL 遇 state 已非 managed → 只写 aborted 终态记录（内部 WAL 文件）+ 账本告警，零外写（不动 wake/state/policy），返回 3。"""
    journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'aborted', 'payload': {'reason': f'quarantine: {why}', 'no_external_write': True, 'repair_key': None}})
    ledger_line(chat, f'⚠️ 在途 plan {sha[:16]} 因 state 非 managed 被隔离终止（零外写）：{why[:100]}'); log(f'QUARANTINED in-flight plan {sha[:16]}: {why}'); return 3

# ======== evaluate（§3） ========
QUARANTINE_FACTS = {'msgs': [], 'taskbook': {'valid': False, 'reason': 'quarantine'}, 'tasks': {}, 'last_human': None, 'last_exec': None, 'last_real': None, 'quiet': True, 'idle_ok': True, 'idle_why': 'quarantine',
                    'children': {}, 'since_change': None, 'human_after_change': False, 'exec_after_change': False, 'new_decisions': [], 'unacked_out': [], 'finish_proposals': []}
def facts_for(chat):
    st = read_state(chat); lc = lifecycle_of(st)
    mok, mwhy = managed_state(st)
    if not mok:  # r11 P1-2：非 managed（含类型损坏）在解引用任何 lifecycle 子结构之前返回隔离事实；调用方一律不得据此出 plan/repair
        return dict(QUARANTINE_FACTS, state=st, lc=lc, wake=wake_actual(chat), managed=(False, mwhy), heartbeat=heartbeat())
    since = now() - datetime.timedelta(hours=48)
    msgs = list_messages(chat, start=since)
    wake = wake_actual(chat)
    role_apps = role_apps_for(st)
    tb = taskbook_status(chat, msgs)
    cls = classify_tasks(chat, st, msgs, tb, role_apps)
    human_msgs = [m for m in msgs if sender_kind(m) in ('user',)]
    _ = None
    exec_msgs = [m for m in msgs if sender_kind(m) == 'executor']
    last_human = max((msg_time(m) for m in human_msgs), default=None)
    last_exec = max((msg_time(m) for m in exec_msgs), default=None)
    last_real = max([t for t in (last_human, last_exec) if t], default=None)
    quiet = (now() - last_real).total_seconds() >= MIN_QUIET_SEC if last_real else True
    idle_ok, idle_why = nobody_working(chat)
    children = child_lifecycles(st)
    changed_at = lc.get('status_changed_at')
    try: since_change = (now() - datetime.datetime.strptime(changed_at, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)).total_seconds() if changed_at else None
    except Exception: since_change = None
    def after_change(t): return t is not None and (changed_at is None or t > datetime.datetime.strptime(changed_at, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ))
    # decision markers in
    dec_in = []
    for m in msgs:
        for mk in find_markers(msg_text(m)):
            if mk.get('decision_id') and sender_kind(m) in ('user', 'executor', 'app'): dec_in.append({'decision_id': mk['decision_id'], 'message_id': m['message_id'], 'at': m['create_time']})
    known_in = {d.get('decision_id') for d in lc['decisions'].get('in', [])}
    new_dec = [d for d in dec_in if d['decision_id'] not in known_in]
    unacked_out = [d for d in lc['decisions'].get('out', []) if d.get('state') not in ('acked', 'cancelled')]
    finish_proposals = [m for m in exec_msgs if any(k.get('finish_proposal') for k in find_markers(msg_text(m))) and after_change(msg_time(m))]
    return {'state': st, 'lc': lc, 'msgs': msgs, 'wake': wake, 'taskbook': tb, 'tasks': cls, 'last_human': last_human, 'last_exec': last_exec, 'last_real': last_real,
            'quiet': quiet, 'idle_ok': idle_ok, 'idle_why': idle_why, 'children': children, 'since_change': since_change,
            'human_after_change': after_change(last_human), 'exec_after_change': after_change(last_exec), 'new_decisions': new_dec,
            'unacked_out': unacked_out, 'finish_proposals': [m['message_id'] for m in finish_proposals], 'heartbeat': heartbeat(), 'managed': (True, mwhy)}

def input_digest(chat, f):
    lc = f['lc']; st = f['state'] or {}
    d = {'lifecycle': lc, 'tasks': {k: ({kk: v.get(kk) for kk in ('status', 'kind', 'evidence', 'deps', 'blocked_on')} if isinstance(v, dict) else str(v)) for k, v in (st.get('tasks') or {}).items()},
         'cron': f['wake']['cron'], 'instant': f['wake']['instant'], 'children': f['children'], 'journal_seq': journal_head_seq(chat),
         'receipts': [r for r in journal(chat) if r.get('kind') == 'actor_receipt'][-5:]}
    return csha(d)

def evaluate(chat, f=None):
    """返回 {current, proposed, guards[], facts_summary, reason}；proposed==current 表示不动。"""
    f = f or facts_for(chat); lc = f['lc']; cur = lc['status']; g = []
    def guard(name, ok, why=''): g.append({'guard': name, 'pass': bool(ok), 'why': why}); return bool(ok)
    mok, mwhy = f.get('managed') or managed_state(f['state'])
    if not guard('managed state (schema>=4 + lifecycle deep-valid + wake readback + provenance)', mok, mwhy):
        return {'current': cur, 'proposed': cur, 'guards': g, 'reason': f'quarantine: {mwhy}', 'facts_summary': {}}
    children = f['children']; child_active = any(c.get('status') == 'active' for c in children.values())
    child_unknown = [c for c, v in children.items() if v.get('status') == 'unknown']
    child_gen_moved = any(v.get('generation') is not None and lc['children_seen'].get(c) != v.get('generation') for c, v in children.items())
    _tasks = (f['state'] or {}).get('tasks', {})
    new_task = any(r['cls'] == 'undecidable' and isinstance(_tasks.get(t), dict) and _tasks[t].get('status') == 'in_progress' for t, r in f['tasks'].items())
    prio1 = f['new_decisions'] or child_active or child_gen_moved or new_task
    # unmanaged：任一活动 → active（repair 事务负责实际转换）
    if cur == 'unmanaged':
        cs = lc.get('candidate_since')
        try: cs_t = datetime.datetime.strptime(cs, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ) if cs else None
        except Exception: cs_t = None
        if cs_t is None: return {'current': cur, 'proposed': cur, 'guards': g, 'reason': 'unmanaged without candidate_since (undecidable)'}
        act = (f['last_human'] is not None and f['last_human'] > cs_t) or (f['last_exec'] is not None and f['last_exec'] > cs_t) or child_active or new_task
        return {'current': cur, 'proposed': 'active' if act else cur, 'guards': g, 'via': 'repair' if act else None, 'reason': 'unmanaged activity' if act else 'no activity'}
    if cur == 'finished':
        rp = lc.get('reopen_pending')
        r, why = valid_receipt(chat, rp, rp.get('generation') if rp else None, lc, kind='reopen')
        guard('reopen receipt', bool(r), why)
        if r and not prio1: return {'current': cur, 'proposed': 'active', 'guards': g, 'reason': 'reopen confirmed', 'receipt': r}
        return {'current': cur, 'proposed': cur, 'guards': g, 'reason': why}
    if cur == 'paused':
        fp = lc.get('finish_pending')
        if prio1:
            return {'current': cur, 'proposed': 'active', 'guards': g, 'reason': 'priority-1 event (decision/child active/new task)', 'clear_pending': True}
        if fp:
            r, why = valid_receipt(chat, fp, fp.get('generation_after'), lc, kind='finish')
            guard('finish receipt', bool(r), why)
            if r and guard('cron count 0', len(f['wake']['cron']) == 0, f"cron={len(f['wake']['cron'])}") and guard('heartbeat healthy', (f['heartbeat']['healthy_age'] if f['heartbeat']['healthy_age'] is not None else 1e9) < HEARTBEAT_MAX_AGE, str(f['heartbeat'])):
                return {'current': cur, 'proposed': 'finished', 'guards': g, 'reason': 'finish confirmed by actor', 'receipt': r}
            rs = receipts(chat, fp['proposal_id'])
            if f['human_after_change']: return {'current': cur, 'proposed': 'active', 'guards': g, 'reason': 'human message after pause'}
            if rs and rs[-1].get('payload', {}).get('selected') == 'cancel': return {'current': cur, 'proposed': cur, 'guards': g, 'reason': 'cancel', 'clear_pending': True}
        if f['human_after_change']: return {'current': cur, 'proposed': 'active', 'guards': g, 'reason': 'human message after pause'}
        return {'current': cur, 'proposed': cur, 'guards': g, 'reason': 'still waiting'}
    # active：不短路，让守卫逐条给出原因（prio1 事件本身会使相应守卫失败）
    guard('active wake invariant (exactly one cron + instant on)', len(f['wake']['cron']) == 1 and f['wake']['instant'] == 'on', f"cron={len(f['wake']['cron'])} instant={f['wake']['instant']}")
    ok_tasks, why_t = only_waiting_owner(f['tasks'])
    guard('taskbook valid', f['taskbook'].get('valid'), f['taskbook'].get('reason', ''))
    guard('all remaining work waits owner', ok_tasks, why_t)
    guard('30min quiet', f['quiet'], f"last_real={f['last_real']}")
    guard('nobody working', f['idle_ok'], f['idle_why'])
    guard('no unacked outbound decision', not f['unacked_out'], str([d.get('decision_id', '')[:12] for d in f['unacked_out']]))
    guard('dwell', f['since_change'] is None or f['since_change'] >= MIN_DWELL_SEC, str(f['since_change']))
    if children:
        guard('children all paused/finished', all(v.get('status') in ('paused', 'finished') for v in children.values()), str({c[:11]: v.get('status') for c, v in children.items()}))
        guard('no unknown child', not child_unknown, str([c[:11] for c in child_unknown]))
        guard('children generation consumed', not child_gen_moved, '')
    guard('heartbeat healthy', (f['heartbeat']['healthy_age'] if f['heartbeat']['healthy_age'] is not None else 1e9) < HEARTBEAT_MAX_AGE, str(f['heartbeat']))  # S3 r2：age 恰为 0.0 不是缺失
    allp = all(x['pass'] for x in g)
    if allp:
        return {'current': cur, 'proposed': 'paused', 'guards': g, 'reason': 'all guards pass', 'finish_proposal': f['finish_proposals'][0] if f['finish_proposals'] else None}
    return {'current': cur, 'proposed': cur, 'guards': g, 'reason': 'guards failed'}

def write_plan(chat, f, ev):
    lc = f['lc']
    mok, mwhy = managed_state(f['state'])
    if not mok: raise GateFail(f'refuse to write plan: {mwhy}')
    plan = {'chat': chat, 'current': ev['current'], 'proposed': ev['proposed'], 'guards': ev['guards'], 'reason': ev.get('reason'),
            'clear_pending': bool(ev.get('clear_pending')), 'finish_proposal': ev.get('finish_proposal'), 'via': ev.get('via'),
            'receipt_seq': (ev.get('receipt') or {}).get('seq'), 'expected_generation': lc['status_generation'], 'input_digest': input_digest(chat, f),
            'facts': {'cron': f['wake']['cron'], 'instant': f['wake']['instant'], 'tasks': {k: v['cls'] for k, v in f['tasks'].items()}, 'children': f['children']}}
    body = canonical(plan).encode(); sha = sha256b(body); ensure_dirs(chat)
    path = os.path.join(p_plans(chat), sha + '.json')
    if not os.path.exists(path):
        atomic_write(path, body); os.chmod(path, 0o444); atomic_write(path + '.meta', json.dumps({'created_at': ts()}).encode())
    return path, sha, plan

def eval_and_plan(chat):
    with ChatLock(chat):
        f = facts_for(chat); ev = evaluate(chat, f)
        out = {'chat': chat, 'current': ev['current'], 'proposed': ev['proposed'], 'guards': ev['guards'], 'reason': ev.get('reason'), 'plan': None}
        if ev['proposed'] != ev['current'] or ev.get('clear_pending'):
            if ev.get('via') == 'repair':
                out['repair'] = create_repair_locked(chat, 'unmanaged_activity', f['lc'], f['wake'])
            else:
                path, sha, plan = write_plan(chat, f, ev); out['plan'] = path; out['plan_sha'] = sha
        return out

# ======== apply（§6.2 硬门 + §6.3 WAL + §6.4 恢复/补偿） ========
def load_plan(path):
    rp = os.path.realpath(path); chat_dir = os.path.dirname(rp)
    if os.path.islink(path) or not rp.startswith(os.path.realpath(os.path.join(P5_HOME, 'plans')) + os.sep): raise GateFail('plan path outside plans/ or symlink')
    body = open(rp, 'rb').read(); sha = sha256b(body)
    if os.path.basename(rp) != sha + '.json': raise GateFail('plan filename != sha256(content)')
    plan = json.loads(body)
    if os.path.realpath(os.path.dirname(rp)) != os.path.realpath(p_plans(plan['chat'])): raise GateFail('plan path not under plans/<chat short>/ of its own chat')
    return plan, sha

def cron_template_from(lc, wake):
    if wake['cron']: return wake['cron'][0]
    bk = (lc.get('wake_backup') or {}).get('cron')
    if bk: return bk
    return None

def postimage_for(plan, lc, receipt_wake, receipt=None):
    new = json.loads(json.dumps(lc)); p = plan['proposed']
    new['status'] = p; new['status_generation'] = lc['status_generation'] + 1; new['status_changed_at'] = ts()
    new['wake'] = {'cron': receipt_wake['cron'][0] if receipt_wake['cron'] else None, 'instant': receipt_wake['instant']}
    if plan['current'] == 'active' and p == 'paused':
        new['wake_backup'] = {'cron': lc['wake'].get('cron') or (plan['facts']['cron'][0] if plan['facts']['cron'] else None), 'instant': 'on'}
        if plan.get('finish_proposal'):
            new['finish_pending'] = {'proposal_id': str(uuid.uuid4()), 'generation_after': new['status_generation'], 'proposed_at': ts(), 'proposal_message_id': plan['finish_proposal'], 'asks': []}
    if p == 'active': new['finish_pending'] = None; new['reopen_pending'] = None; new['candidate_since'] = None
    if plan.get('clear_pending') and p == plan['current']: new['finish_pending'] = None; new['status_generation'] = lc['status_generation'] + 1
    if p == 'finished':
        r = receipt or {}; pl = r.get('payload', {})
        new['provenance'] = {'kind': 'ask_actor', 'proposal_id': (lc.get('finish_pending') or {}).get('proposal_id'), 'attempt': r.get('attempt'), 'ask_lark_app_id': pl.get('ask_lark_app_id'), 'by': pl.get('by'), 'selected': 'confirm', 'at': pl.get('at')}
        new['finish_pending'] = None
    if plan['current'] == 'finished' and p == 'active':
        r = receipt or {}; pl = r.get('payload', {})
        new['provenance'] = {'kind': 'ask_actor', 'proposal_id': (lc.get('reopen_pending') or {}).get('proposal_id'), 'attempt': r.get('attempt'), 'ask_lark_app_id': pl.get('ask_lark_app_id'), 'by': pl.get('by'), 'selected': 'confirm', 'at': pl.get('at')}
    return new

def apply_plan(path, do_apply=False, log=print):
    plan, sha = load_plan(path); chat = plan['chat']; ensure_dirs(chat)
    with ChatLock(chat):
        last = journal_last(chat, sha)
        mok, mwhy = managed_state(read_state(chat))
        if last:
            if last['phase'] == 'committed': log('already committed'); return 0
            if last['phase'] in ('compensated', 'aborted'): log('terminal-aborted; re-eval needed'); return 0
            if not mok: return quarantine_inflight_plan(chat, sha, mwhy, log)  # 恢复也过 managed 硬门：非 managed 只写终态记录
            log(f'resuming from phase {last["phase"]}'); return _resume(chat, plan, sha, log) if do_apply else 2
        if not mok: raise GateFail(f'managed hard gate: {mwhy}')  # 任何 journal intent / 外写之前
        f = facts_for(chat); lc = f['lc']
        if lc['status_generation'] != plan['expected_generation']: raise GateFail(f'generation {lc["status_generation"]} != expected {plan["expected_generation"]}')
        dg = input_digest(chat, f)
        if dg != plan['input_digest']: raise GateFail('input_digest drift')
        ev = evaluate(chat, f)
        if ev['proposed'] != plan['proposed'] or bool(ev.get('clear_pending')) != plan.get('clear_pending', False): raise GateFail(f'fresh evaluate proposed={ev["proposed"]} != plan {plan["proposed"]}')
        if plan['proposed'] != plan['current'] and any(not x['pass'] for x in ev['guards']) and plan['proposed'] in ('paused', 'finished'): raise GateFail('guards no longer pass')
        closing = plan['proposed'] in ('paused', 'finished')
        if closing:
            hb = f['heartbeat']
            if hb['healthy_age'] is None or hb['healthy_age'] >= HEARTBEAT_MAX_AGE: raise GateFail(f'repair heartbeat not healthy: {hb}')
            if cfg().get('mode') != 'apply' or chat not in cfg().get('apply_groups', []): raise GateFail('config mode/apply_groups forbids closing transition')
            if plan['proposed'] == 'finished' and not cfg().get('finished_automation'): raise GateFail('finished_automation disabled')
        if plan['proposed'] == 'finished' and len(f['wake']['cron']) != 0: raise GateFail('paused invariant (cron 0) not satisfied before finished')
        receipt = None
        if plan.get('receipt_seq'):
            rr = [r for r in journal(chat) if r.get('seq') == plan['receipt_seq']]; receipt = rr[0] if rr else None
            if not receipt: raise GateFail('receipt missing')
        if not do_apply:
            log(f'DRY-RUN ok: {plan["current"]} -> {plan["proposed"]} ({plan["reason"]})'); return 0
        tpl = cron_template_from(lc, f['wake'])
        desired = desired_for(plan['proposed'], tpl if plan['proposed'] == 'active' else None)
        if plan['proposed'] == plan['current']: desired = desired_for(plan['current'], tpl if plan['current'] == 'active' else None)
        pre = {'lifecycle_sha': lifecycle_sha(lc), 'generation': lc['status_generation'], 'wake': f['wake'], 'cron_template': tpl}
        journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'intent', 'payload': {'preimage': pre, 'desired': desired, 'plan': plan}})
        return _execute(chat, plan, sha, pre, desired, receipt, log)

def _do_action(chat, plan, pre, desired, log):
    """执行 wake 动作并 readback；返回 receipt(wake_actual)。失败抛异常。"""
    before = load_schedules(); cur, prop = plan['current'], plan['proposed']
    if prop == 'paused' and cur == 'active':
        for c in pre['wake']['cron']: schedule_remove(c['id'])
    elif prop == 'active' and cur in ('paused', 'finished', 'unmanaged'):
        if pre['wake']['instant'] != 'on': instant_set(chat, True)
        tpl = pre.get('cron_template')
        if not tpl: raise RuntimeError('no cron template to restore')
        if any(e.get('name') == tpl['name'] and e.get('chatId') == chat and e.get('enabled') for e in before.values() if e.get('parsed', {}).get('kind') == 'cron'): raise RuntimeError('same-name cron already exists')
        schedule_add(tpl, chat)
    elif prop == 'finished': instant_set(chat, False)
    after = load_schedules(); act = wake_actual(chat)
    if not satisfies(act, desired): raise RuntimeError(f'readback does not satisfy desired: {act} vs {desired}')
    changed = {i for i in set(before) | set(after) if before.get(i) != after.get(i)}
    ok, bad = others_unchanged(before, after, changed if prop != 'active' else changed)
    touched = {c['id'] for c in pre['wake']['cron']} | {c['id'] for c in act['cron']}
    ok, bad = others_unchanged(before, after, touched)
    if not ok: raise RuntimeError(f'other schedule entry changed: {bad}')
    return act

def _execute(chat, plan, sha, pre, desired, receipt, log):
    try:
        act = _do_action(chat, plan, pre, desired, log)
    except Exception as e:
        log(f'action failed: {e}')
        _compensate(chat, plan, sha, pre, desired, log, reason=str(e)); return 3
    journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'action_done', 'payload': {'receipt': act}})
    return _commit_state(chat, plan, sha, pre, desired, act, receipt, log)

def _commit_state(chat, plan, sha, pre, desired, act, receipt, log):
    st = read_state(chat) or {}; lc = lifecycle_of(st)
    try:  # r11 P1-2：postimage/state_write_intent 生成也在可补偿边界内（类型损坏/注入故障 → 补偿开向，不留 cron0+active）
        if os.environ.get('P5_FAULT') == 'postimage': raise TypeError('injected postimage failure')
        post = postimage_for(plan, lc, act, receipt); post_sha = lifecycle_sha(post)
        journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'state_write_intent', 'payload': {'postimage': post, 'postimage_sha': post_sha}})
    except Exception as e:
        log(f'postimage/state_write_intent failed: {e}'); _compensate(chat, plan, sha, pre, desired, log, reason=f'postimage: {e}'); return 3
    try:
        if lifecycle_sha(lc) != pre['lifecycle_sha']: raise RuntimeError('CAS failed: lifecycle changed')
        st['lifecycle'] = post; st['paused'] = (post['status'] == 'finished'); st['updated_at'] = now().strftime('%Y-%m-%d %H:%M')
        if os.environ.get('P5_FAULT') == 'rename': raise RuntimeError('injected rename failure')
        write_state(chat, st)
    except Exception as e:
        cur = lifecycle_of(read_state(chat) or {})
        if lifecycle_sha(cur) == post_sha:
            log('rename actually succeeded; finishing phases')
        else:
            log(f'state commit failed: {e}')
            _compensate(chat, plan, sha, pre, desired, log, reason=str(e)); return 3
    rb = lifecycle_of(read_state(chat) or {})
    if lifecycle_sha(rb) != post_sha:
        log('state readback != postimage'); _compensate(chat, plan, sha, pre, desired, log, reason='state readback mismatch'); return 3
    journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'state_committed', 'payload': {'lifecycle_sha': post_sha, 'generation': post['status_generation'], 'readback': True}})
    journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'committed', 'payload': {}})
    try: atomic_write(os.path.join(p_plans(chat), sha + '.json.consumed'), ts().encode())
    except Exception: pass
    ledger_line(chat, f"转换 {plan['current']}→{post['status']} committed plan={sha[:16]} gen={post['status_generation']} reason={plan.get('reason')}")
    log(f'COMMITTED {plan["current"]} -> {post["status"]} gen={post["status_generation"]}'); return 0

def _compensate(chat, plan, sha, pre, desired, log, reason=''):
    cur = lifecycle_of(read_state(chat) or {})
    journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'compensation_intent', 'payload': {'reason': reason}})
    try:
        act = wake_actual(chat)
        if os.environ.get('P5_FAULT') == 'compensate': raise RuntimeError('injected compensation failure')
        if not satisfies(act, _wake_desired_of(pre['wake'], pre.get('cron_template'))):
            if pre['wake']['instant'] == 'on' and act['instant'] != 'on': instant_set(chat, True)
            if pre['wake']['cron'] and not act['cron']: schedule_add(pre['wake']['cron'][0], chat)
            act = wake_actual(chat)
            if not satisfies(act, _wake_desired_of(pre['wake'], pre.get('cron_template'))): raise RuntimeError('compensation readback mismatch')
        journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'compensated', 'payload': {'wake': act}})
        ledger_line(chat, f'转换失败已补偿 plan={sha[:16]} reason={reason[:80]}'); log('COMPENSATED')
        cur2 = lifecycle_of(read_state(chat) or {})
        if drift_row(cur2, act):
            rk = create_repair_locked(chat, 'post_compensation_drift', cur2, act)
            ledger_line(chat, f'⚠️ 补偿后 state/wake 仍不一致，已建 repair {(rk or "none(quarantined)")[:16]}'); log(f'post-compensation drift → repair {(rk or "none(quarantined)")[:16]}')
    except Exception as e:
        rk = create_repair_locked(chat, 'compensation_failed', cur, wake_actual(chat), needed_status=pre_status_of(pre), tpl=pre.get('cron_template'))
        journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'aborted', 'payload': {'reason': f'compensation failed: {e}', 'repair_key': rk}})
        ledger_line(chat, f'⚠️ 补偿失败，已建 repair {(rk or "none(quarantined)")[:16]}（plan {sha[:16]}），等待修复源'); log(f'ABORTED with repair {(rk or "none(quarantined)")[:16]}')
def pre_status_of(pre):
    return 'active' if pre['wake']['cron'] else ('paused' if pre['wake']['instant'] == 'on' else 'finished')
def _wake_desired_of(wake, tpl):
    if wake['cron']: return desired_for('active', tpl or wake['cron'][0])
    return {'cron': {'count': 0}, 'instant': wake['instant']}

def _resume(chat, plan, sha, log):
    rs = [r for r in journal(chat) if r.get('kind') == 'plan' and r.get('plan_sha') == sha]
    intent = [r for r in rs if r['phase'] == 'intent'][0]['payload']; pre, desired = intent['preimage'], intent['desired']
    last = rs[-1]; act = wake_actual(chat); cur = lifecycle_of(read_state(chat) or {})
    receipt = None
    if plan.get('receipt_seq'):
        rr = [r for r in journal(chat) if r.get('seq') == plan['receipt_seq']]; receipt = rr[0] if rr else None
    if last['phase'] == 'intent':
        if lifecycle_sha(cur) != pre['lifecycle_sha']: return _abort_with_repair(chat, sha, cur, act, 'intent: lifecycle changed since preimage', log)
        if satisfies(act, desired):
            journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'action_done', 'payload': {'receipt': act, 'recovered': True}})
            return _commit_state(chat, plan, sha, pre, desired, act, receipt, log)
        if satisfies(act, _wake_desired_of(pre['wake'], pre.get('cron_template'))):
            return _execute(chat, plan, sha, pre, desired, receipt, log)
        return _abort_with_repair(chat, sha, cur, act, 'intent: wake neither pre nor desired', log)
    if last['phase'] == 'action_done':
        if not satisfies(act, desired): return _abort_with_repair(chat, sha, cur, act, 'action_done: current wake no longer satisfies desired', log)
        if lifecycle_sha(cur) != pre['lifecycle_sha']: return _abort_with_repair(chat, sha, cur, act, 'action_done: lifecycle changed since preimage', log)
        return _commit_state(chat, plan, sha, pre, desired, act, receipt, log)
    if last['phase'] == 'state_write_intent':
        post = last['payload']['postimage']; psha = last['payload']['postimage_sha']
        if lifecycle_sha(cur) == psha:
            if not satisfies(act, desired): return _abort_with_repair(chat, sha, cur, act, 'state_write_intent: state is postimage but wake drifted', log)
            journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'state_committed', 'payload': {'lifecycle_sha': psha, 'generation': post['status_generation'], 'recovered': True, 'readback': True}})
            journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'committed', 'payload': {}}); log('recovered: committed'); return 0
        if lifecycle_sha(cur) == pre['lifecycle_sha']:
            if not satisfies(act, desired): return _abort_with_repair(chat, sha, cur, act, 'state_write_intent: wake no longer satisfies desired', log)
            st = read_state(chat) or {}; st['lifecycle'] = post; st['paused'] = (post['status'] == 'finished'); write_state(chat, st)
            if lifecycle_sha(lifecycle_of(read_state(chat) or {})) != psha: return _abort_with_repair(chat, sha, lifecycle_of(read_state(chat) or {}), act, 'state_write_intent: readback mismatch after rename', log)
            journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'state_committed', 'payload': {'lifecycle_sha': psha, 'generation': post['status_generation']}})
            journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'committed', 'payload': {}}); log('recovered: renamed+committed'); return 0
        return _abort_with_repair(chat, sha, cur, act, 'state_write_intent: state neither pre nor post', log)
    if last['phase'] == 'state_committed':
        psha = last['payload']['lifecycle_sha']
        if lifecycle_sha(cur) != psha: return _abort_with_repair(chat, sha, cur, act, 'state_committed: lifecycle != postimage', log)
        if not satisfies(act, desired): return _abort_with_repair(chat, sha, cur, act, 'state_committed: wake drifted before committed', log)
        journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'committed', 'payload': {'recovered': True}}); return 0
    if last['phase'] == 'compensation_intent':
        if lifecycle_sha(cur) != pre['lifecycle_sha']: return _abort_with_repair(chat, sha, cur, act, 'compensation_intent: lifecycle != preimage', log)
        if satisfies(act, _wake_desired_of(pre['wake'], pre.get('cron_template'))):
            journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'compensated', 'payload': {'wake': act, 'recovered': True}}); log('recovered: compensated'); return 0
        if satisfies(act, desired):
            _compensate(chat, plan, sha, pre, desired, log, reason='resume compensation'); return 3
        return _abort_with_repair(chat, sha, cur, act, 'compensation_intent: wake ambiguous', log)
    return 0
def _abort_with_repair(chat, sha, lc, act, reason, log):
    rk = create_repair_locked(chat, 'recovery_ambiguous', lc, act)
    journal_append(chat, {'kind': 'plan', 'plan_sha': sha, 'phase': 'aborted', 'payload': {'reason': reason, 'repair_key': rk}})
    ledger_line(chat, f'⚠️ 恢复不可判定，plan {sha[:16]} aborted，repair {(rk or "none(quarantined)")[:16]}'); log(f'ABORTED: {reason}; repair {(rk or "none(quarantined)")[:16]}'); return 3

# ======== repair（§6.6，独立 repair_key，开向） ========
def drift_row(lc, act, needed_status=None):
    """返回 (needed, desired, post_status, extra) 或 None。开向漂移表。"""
    s = lc['status']; ncron = len(act['cron']); inst = act['instant']
    if needed_status == 'active' or (s == 'active' and (ncron != 1 or inst != 'on')): return 'restore_active', 'active'
    if s == 'paused' and ncron >= 1: return 'paused_with_cron', 'active'
    if s == 'paused' and inst != 'on': return 'paused_instant_off', 'paused'
    if s == 'finished' and ncron >= 1: return 'finished_with_cron', 'active'
    if s == 'finished' and inst == 'on': return 'finished_instant_on', 'paused'
    if s == 'unmanaged' and ncron >= 1: return 'unmanaged_with_cron', 'active'
    if s == 'unmanaged' and inst != 'on': return 'unmanaged_instant_off', 'unmanaged'
    return None
def create_repair_locked(chat, needed, lc, act, needed_status=None, tpl=None):
    """必须已持有 chat 锁。同 key 未 committed 则复用。"""
    mok, mwhy = managed_state(read_state(chat))
    if not mok: ledger_line(chat, f'⚠️ 需要 repair({needed}) 但 state 非 managed，已隔离不建 repair（零外写）：{mwhy[:100]}'); return None  # r11 P1-1：非 managed 不建 repair
    row = drift_row(lc, act, needed_status)
    if needed == 'unmanaged_activity': target = 'active'
    elif row: needed, target = row
    else: target = needed_status or 'active'
    tpl = tpl or cron_template_from(lc, act)
    desired = desired_for(target, tpl if target == 'active' else None)
    pre_sha = csha({'lifecycle_sha': lifecycle_sha(lc), 'wake': act})
    key = sha256b(f'{chat}|{needed}|{pre_sha}|{canonical(desired)}'.encode())
    rs = [r for r in read_jsonl(p_repairs(chat)) if r.get('repair_key') == key]
    if rs and rs[-1]['phase'] not in ('committed', 'superseded'): return key
    if lifecycle_sha(lifecycle_of(read_state(chat) or {})) != lifecycle_sha(lc): return None  # S3 r5：调用方在锁外算的前像已过时（并发事务刚提交）→ 不用陈旧前像开 repair（否则只会白写一笔 intent+superseded）；下一轮 audit 按新前像重算
    rec = {'repair_key': key, 'phase': 'intent', 'at': ts(), 'payload': {'needed': needed, 'target': target, 'desired': desired, 'preimage': {'lifecycle_sha': lifecycle_sha(lc), 'generation': lc['status_generation'], 'wake': act, 'cron_template': tpl}}}
    append_fsync(p_repairs(chat), rec); return key
def unresolved_repairs(chat):
    by = {}
    for r in read_jsonl(p_repairs(chat)): by[r['repair_key']] = r
    return [k for k, r in by.items() if r['phase'] not in ('committed', 'superseded')]
def execute_repair(chat, key, log=print):
    with ChatLock(chat):
        rs = [r for r in read_jsonl(p_repairs(chat)) if r['repair_key'] == key]
        if not rs: raise RuntimeError('unknown repair');
        if rs[-1]['phase'] == 'committed': return 0
        intent = [r for r in rs if r['phase'] == 'intent'][0]['payload']; desired, pre, target = intent['desired'], intent['preimage'], intent['target']
        last = rs[-1]['phase']; act = wake_actual(chat); st = read_state(chat) or {}; lc = lifecycle_of(st)
        def J(phase, payload): append_fsync(p_repairs(chat), {'repair_key': key, 'phase': phase, 'at': ts(), 'payload': payload})
        if rs[-1]['phase'] in ('superseded',): return 0
        mok, mwhy = managed_state(st)
        if not mok:  # r11 P1-1：续做/执行 repair 也过 managed 硬门：只写 superseded 终态（内部 WAL）+ 账本告警，零外写
            J('superseded', {'note': f'quarantine: {mwhy}', 'no_state_write': True, 'no_external_write': True}); ledger_line(chat, f'⚠️ repair {key[:16]} 因 state 非 managed 被隔离终止（零外写）：{mwhy[:100]}'); log(f'QUARANTINED repair {key[:16]}: {mwhy}'); return 3
        # 外写前 CAS：lifecycle 必须仍是 intent 的 preimage（generation/sha 未变），否则 superseded、不做任何外写，让下一轮 audit 按新 preimage 重建 repair
        if last == 'intent' and (lifecycle_sha(lc) != pre['lifecycle_sha'] or lc['status_generation'] != pre['generation']):
            J('superseded', {'note': 'lifecycle changed before action; no external write', 'no_state_write': True})
            if drift_row(lc, act):  # 当前实物仍漂移 → 按新 preimage 立即新建可收敛 repair，并以非零告知调用方（rc 0 只表示"现在已一致"）
                nk = create_repair_locked(chat, 'recovery_ambiguous', lc, act, tpl=pre.get('cron_template')); log(f'repair superseded (pre-action CAS); new repair {nk[:16]}'); return 3
            log('repair superseded (pre-action CAS); current state consistent'); return 0
        def supersede_and_renew(note):
            """wake 维度失配：本 repair 标 superseded，并按当前 lifecycle+wake 新建可收敛的 repair（同锁内），返回 3。"""
            cur_lc = lifecycle_of(read_state(chat) or {}); cur_act = wake_actual(chat)
            J('superseded', {'note': note, 'wake': cur_act, 'no_state_write': True})
            nk = create_repair_locked(chat, 'recovery_ambiguous', cur_lc, cur_act, tpl=pre.get('cron_template')) if drift_row(cur_lc, cur_act) else None
            log(f'repair superseded ({note}); new repair {nk[:16] if nk else "none (already consistent)"}'); return 3
        if last in ('intent',):
            if canonical(act) != canonical(pre['wake']): return supersede_and_renew('wake changed since intent (pre-action)')
            if not satisfies(act, desired):
                if desired.get('instant') == 'on' and act['instant'] != 'on': instant_set(chat, True)
                if desired.get('instant') == 'off' and act['instant'] != 'off': instant_set(chat, False)
                if desired['cron'].get('exactly_one'):
                    if not act['cron']:
                        tpl = pre.get('cron_template') or cron_template_from(lc, act)
                        if not tpl: raise RuntimeError('no cron template for repair')
                        schedule_add(tpl, chat)
                    elif len(act['cron']) > 1:
                        reg = registered_wake_ids(chat); keep = sorted(act['cron'], key=lambda c: (0 if c.get('id') in reg else 1, c.get('id') or ''))[0]
                        for c in act['cron']:
                            if c.get('id') != keep.get('id'): schedule_remove(c['id'])
                elif 'count' in desired['cron'] and desired['cron']['count'] == 0:
                    for c in act['cron']: schedule_remove(c['id'])
                act = wake_actual(chat)
                if not satisfies(act, desired): return supersede_and_renew(f'readback after action does not satisfy desired: {act}')
            J('action_done', {'receipt': act}); last = 'action_done'
        if last == 'action_done':
            if lifecycle_sha(lc) != pre['lifecycle_sha'] or lc['status_generation'] != pre['generation']:
                J('superseded', {'note': 'lifecycle changed after action (resume); needs re-audit', 'wake': act}); log('repair superseded (action_done resume CAS)'); return 3
            if not satisfies(act, desired): return supersede_and_renew('action_done resume: wake no longer satisfies desired')
            post = json.loads(json.dumps(lc)); post['status'] = target; post['status_generation'] = lc['status_generation'] + 1; post['status_changed_at'] = ts()
            post['wake'] = {'cron': act['cron'][0] if act['cron'] else None, 'instant': act['instant']}
            if target == 'active': post['finish_pending'] = None; post['candidate_since'] = None; post['reopen_pending'] = None
            if lc['status'] == 'finished' and target in ('active', 'paused'):
                post['finished_evidence'] = lc.get('provenance'); post['provenance'] = None
            if target == 'paused' and lc['status'] == 'finished': pass  # finish_pending 保留
            J('state_write_intent', {'postimage': post, 'postimage_sha': lifecycle_sha(post)}); last = 'state_write_intent'
            rs = [r for r in read_jsonl(p_repairs(chat)) if r['repair_key'] == key]
        if last == 'state_write_intent':
            payload = [r for r in rs if r['phase'] == 'state_write_intent'][-1]['payload']; post = payload['postimage']; psha = payload['postimage_sha']
            cur = lifecycle_of(read_state(chat) or {})
            if lifecycle_sha(cur) != psha:
                if lifecycle_sha(cur) != pre['lifecycle_sha']:
                    # 动作已做但状态被别的事务改动：不能留 wake/state 分裂 → 标 superseded 并返回非 0，audit 会按新 preimage 重建 repair
                    J('superseded', {'note': 'lifecycle changed after action; needs re-audit', 'wake': act}); log('repair superseded after action'); return 3
                if not satisfies(wake_actual(chat), desired): return supersede_and_renew('state_write_intent resume: wake drifted before state write')
                st = read_state(chat) or {}; st['lifecycle'] = post; st['paused'] = (post['status'] == 'finished'); write_state(chat, st)
                if lifecycle_sha(lifecycle_of(read_state(chat) or {})) != psha: raise RuntimeError('repair: state readback mismatch')
            J('state_committed', {'lifecycle_sha': psha, 'generation': post['status_generation'], 'readback': True}); last = 'state_committed'
        if last == 'state_committed':
            sc = [r for r in read_jsonl(p_repairs(chat)) if r['repair_key'] == key and r['phase'] == 'state_committed'][-1]['payload']
            cur = lifecycle_of(read_state(chat) or {}); act = wake_actual(chat)
            if lifecycle_sha(cur) != sc['lifecycle_sha']:
                J('superseded', {'note': 'lifecycle != committed postimage at final phase; needs re-audit', 'wake': act}); log('repair superseded (state_committed lifecycle drift)'); return 3
            if not satisfies(act, desired):
                J('superseded', {'note': 'wake drifted after state_committed; needs re-audit', 'wake': act}); log('repair superseded (state_committed wake drift)'); return 3
            J('committed', {}); ledger_line(chat, f'repair {key[:16]} committed → {target}（{intent["needed"]}）'); log(f'REPAIR COMMITTED {key[:16]} -> {target}')
        return 0

# ======== audit（§4.2）/ emit / heartbeat ========
def audit(chat, write_checked=True):
    st = read_state(chat); lc = lifecycle_of(st); act = wake_actual(chat)
    inv = {'active': lambda: len(act['cron']) == 1 and act['instant'] == 'on', 'paused': lambda: len(act['cron']) == 0 and act['instant'] == 'on',
           'finished': lambda: len(act['cron']) == 0 and act['instant'] == 'off', 'unmanaged': lambda: len(act['cron']) == 0 and act['instant'] == 'on'}
    ok = inv.get(lc['status'], lambda: False)()
    entry_errs = validate_wake_entries(chat)
    if entry_errs: ok = False
    row = drift_row(lc, act)
    present, present_why = managed_state(st)
    rep = {'chat': chat, 'lifecycle_present': present, 'status': lc['status'], 'generation': lc['status_generation'], 'cron': len(act['cron']), 'instant': act['instant'], 'invariant_ok': ok if present else None,
           'tuple': (lc['status'], lc['status_generation'], (st or {}).get('paused'), bool(lc.get('finish_pending')), len(act['cron']), act['instant']),
           'open_repair_needed': row[0] if (row and present) else None, 'unresolved_repairs': unresolved_repairs(chat), 'heartbeat': heartbeat(), 'paused_flag': (st or {}).get('paused'), 'wake_entry_errors': entry_errs, 'managed': present, 'managed_reason': present_why}
    if write_checked and present: bookkeeping_write(chat, 'wake_checked_at', ts())
    return rep
def emit_repair(chat):
    with ChatLock(chat):
        st = read_state(chat) or {}
        if not managed_state(st)[0]: return None  # r11 P1-1：非 managed 不建 repair（零写）
        lc = lifecycle_of(st); act = wake_actual(chat); row = drift_row(lc, act)
        if not row: return None
        return create_repair_locked(chat, row[0], lc, act)
def all_chats(strict=False):
    out = []
    for f in glob.glob(os.path.join(P5_HOME, 'webroot', 'state-oc_*.json')):
        try: d = json.load(open(f)); c = d.get('chat_id')
        except Exception as e:
            if strict: raise RuntimeError(f'corrupted state {os.path.basename(f)}: {e}')
            continue
        if c and c.startswith('oc_') and len(c) > 11: out.append(c)
    return sorted(set(out))
def repair_open_all(log=print):
    """timer 入口：开始即写 attempt → 五类探针（Lark 读 / schedules+policies 解析 / 全部 state 解析 / 全部 journal+repairs 解析 / 全 fleet audit 含本轮每个 repair 的六元组）→ 续做 unresolved repair → 漂移与 unmanaged 扫描 → 全部成功才推进 healthy。"""
    write_heartbeat(False, attempt_only=True)
    errors = []; managed = cfg().get('mode') == 'apply'
    try: load_schedules(); load_policies()
    except Exception as e: errors.append(f'store: {e}')
    probe = cfg().get('probe_chat')
    if probe:
        try: lark_probe(probe)
        except Exception as e: errors.append(f'lark: {e}')
    try: chats = all_chats(strict=True)
    except Exception as e: errors.append(str(e)); chats = []
    # 全目录 glob：journal/*.jsonl、repairs/*.jsonl、plans/*/*.json 逐个解析；孤儿（无对应 state）文件同样必须可解析，且孤儿 journal 不得有在途 plan
    shorts = {short(c) for c in chats}
    for sub in ('journal', 'repairs'):
        for f in sorted(glob.glob(os.path.join(P5_HOME, sub, '*.jsonl'))):
            try: rows = read_jsonl(f)
            except Exception as e: errors.append(f'{sub}/{os.path.basename(f)}: {e}'); continue
            s = os.path.basename(f)[:-6]
            if s not in shorts:
                if sub == 'journal':
                    last = {}
                    for r in rows:
                        if r.get('kind') == 'plan': last[r['plan_sha']] = r['phase']
                    if any(ph not in ('committed', 'compensated', 'aborted') for ph in last.values()): errors.append(f'orphan journal {s} has in-flight plan')
                elif any(r.get('phase') not in ('committed', 'superseded') for r in {r['repair_key']: r for r in rows}.values()): errors.append(f'orphan repairs {s} has unresolved repair')
    for f in sorted(glob.glob(os.path.join(P5_HOME, 'plans', '*', '*.json'))):
        try: json.load(open(f))
        except Exception as e: errors.append(f'plan {os.path.relpath(f, P5_HOME)}: {e}')
    try: registered_wake_ids(chats[0]) if chats else None
    except Exception as e: errors.append(str(e))
    for c in chats:
        try:
            for x in validate_wake_entries(c): errors.append(f'{c[:11]} wake entry: {x}')
        except Exception as e: errors.append(f'{c[:11]} wake entry check: {e}')
    done_repairs = []; quarantined = []
    if managed:
        for c in chats:
            try:
                mok, mwhy = managed_state(read_state(c))
                if not mok: quarantined.append((c, mwhy)); continue  # r11 P1-1：timer 路径非 managed 群一律跳过（不续 repair、不建 repair、不评估），零外写
                for k in unresolved_repairs(c):
                    if execute_repair(c, k, log) == 0: done_repairs.append((c, k))
                k2 = emit_repair(c)
                if k2 and execute_repair(c, k2, log) == 0: done_repairs.append((c, k2))
                lc = lifecycle_of(read_state(c) or {})
                if lc['status'] == 'unmanaged':
                    f = facts_for(c); ev = evaluate(c, f)
                    if ev['proposed'] == 'active':
                        with ChatLock(c): k3 = create_repair_locked(c, 'unmanaged_activity', f['lc'], f['wake'])
                        if k3 and execute_repair(c, k3, log) == 0: done_repairs.append((c, k3))
            except Exception as e: errors.append(f'{c[:11]}: {e}')
        if quarantined: log(f'quarantined (non-managed, no repair/no writes): {[(c[:11], w[:60]) for c, w in quarantined]}')
    # 全 fleet audit（只读，不写 wake_checked_at）+ 本轮 repair 六元组
    for c in chats:
        try:
            r = audit(c, write_checked=False)
            if isinstance(r.get('lifecycle_present'), bool) and r['lifecycle_present'] and not r['invariant_ok']: errors.append(f'{c[:11]} invariant violated: {r["tuple"]}')
        except Exception as e: errors.append(f'{c[:11]} audit: {e}')
    for c, k in done_repairs:
        try:
            r = audit(c, write_checked=False)
            if not r['invariant_ok']: errors.append(f'{c[:11]} repair {k[:12]} left invariant broken: {r["tuple"]}')
        except Exception as e: errors.append(f'{c[:11]} post-repair audit: {e}')
    write_heartbeat(not errors, '; '.join(errors)[:800] if errors else None)
    return errors
