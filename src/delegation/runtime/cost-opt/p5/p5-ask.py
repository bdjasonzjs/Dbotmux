#!/usr/bin/env python3
"""p5-ask.py finish <chat> | reopen <chat>
finish：仅当 finish_pending 存在、attempt<3、且 owner 真人消息 ≤5 分钟 → 锁内簿记 asks[] → 锁外 ask → 锁内 actor_receipt。
reopen：锁内簿记 reopen_pending（首次创建）→ 锁外 ask（执行者 app）→ 锁内 receipt。转换由轮末 eval 的独立 plan 完成。
r12 P1-1/P1-2：两次持锁都先过 managed 硬门（含 pending 递归 schema）；第一次写前非 managed → rc 9 零写零 ask；回锁提交时重验 managed / proposal_id / status / generation / 本 attempt 仍待回执，
任一不符 → 只打印 ask 结果、不写 receipt 不写 state，rc 9（fail-closed：宁可丢一次回执也不写半完成 state）。exit：0 ok；1 前置不满足（无 pending / 窗口 / max asks）；9 managed/一致性拒绝。"""
import sys, os, json, uuid, datetime, subprocess; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
def refuse(msg, extra=None):
    print(json.dumps(dict({'refused': msg, 'no_write': True}, **(extra or {})), ensure_ascii=False)); sys.exit(9)
if len(sys.argv) != 3 or sys.argv[1] not in ('finish', 'reopen') or not (sys.argv[2].startswith('oc_') and len(sys.argv[2]) > 11):
    print(json.dumps({'refused': f'usage: p5-ask.py finish|reopen <oc_full_chat_id> (got {sys.argv[1:]!r})', 'no_write': True})); sys.exit(2)  # r13 P2-1：未知 mode / 参数个数 fail-closed
mode, chat = sys.argv[1], sys.argv[2]
def do_ask(question, app):
    cmd = [BOTMUX_BIN, 'ask', 'buttons', '--json', '--timeout', '240', '--options', 'confirm=确认,cancel=取消', question]
    env = dict(os.environ, BOTMUX_LARK_APP_ID=app)
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    out = {'rc': r.returncode, 'timedOut': r.returncode == 124, 'selected': None, 'by': None}
    try:
        d = json.loads(r.stdout[r.stdout.index('{'):]); out.update({'timedOut': bool(d.get('timedOut')) or r.returncode == 124, 'selected': d.get('selected'), 'by': d.get('by')})
    except Exception: pass
    return out
with ChatLock(chat):
    st = read_state(chat); mok, mwhy = managed_state(st)
    if not mok: refuse(f'managed hard gate: {mwhy}')
    lc = lifecycle_of(st); status0 = lc['status']; gen0 = lc['status_generation']
    if mode == 'finish':
        fp = lc.get('finish_pending')
        if not fp or lc['status'] != 'paused': raise SystemExit('no finish_pending')
        if len(fp.get('asks', [])) >= MAX_ASKS: raise SystemExit('max asks reached')
        msgs = list_messages(chat, start=now() - datetime.timedelta(minutes=5), page_size=20, max_pages=2)
        oid = owner_id_for_app(observer_app())
        recent = [m for m in msgs if sender_kind(m) == 'user' and m.get('sender', {}).get('id') == oid and (now() - msg_time(m)).total_seconds() <= 300]
        if not recent and not os.environ.get('P5_ASK_FORCE'): raise SystemExit('owner not recently active; no ask window')
        app = ask_app_for('finish', st); pending = fp; key = 'finish_pending'
        attempt = len(fp.get('asks', [])) + 1
        asks = fp.get('asks', []) + [{'attempt': attempt, 'started_at': ts(), 'ask_lark_app_id': app, 'receipt': None}]
        lc['finish_pending']['asks'] = asks
        question = f'{st.get("group","本群")}：是否确认结束并关闭 observer 观测？'
    else:
        if lc['status'] != 'finished': raise SystemExit('not finished')
        app = ask_app_for('reopen', st)
        if os.environ.get('BOTMUX_LARK_APP_ID') and os.environ['BOTMUX_LARK_APP_ID'] != app: refuse(f'reopen ask must be issued by the registered executor app {app!r}, not {os.environ["BOTMUX_LARK_APP_ID"]!r}')
        rp = lc.get('reopen_pending') or {'proposal_id': str(uuid.uuid4()), 'generation': lc['status_generation'], 'asks': []}
        if len(rp.get('asks', [])) >= MAX_ASKS: raise SystemExit('max asks reached')
        attempt = len(rp['asks']) + 1; rp['asks'].append({'attempt': attempt, 'started_at': ts(), 'ask_lark_app_id': app, 'receipt': None})
        lc['reopen_pending'] = rp; pending = rp; key = 'reopen_pending'
        question = f'{st.get("group","本群")}：确认重开该群观测？'
    st['lifecycle'] = lc
    errs = pending_schema_errors('finish' if mode == 'finish' else 'reopen', lc[key], st)
    if errs or not managed_state(st)[0]: refuse(f'pending would be invalid after bookkeeping: {errs or managed_state(st)[1]}')
    write_state(chat, st)
pid = pending['proposal_id']
res = do_ask(question, app)  # 锁外
if os.environ.get('P5_TEST_HOOK_ASK'): subprocess.run(os.environ['P5_TEST_HOOK_ASK'], shell=True)
with ChatLock(chat):
    st = read_state(chat); mok, mwhy = managed_state(st)
    if not mok: refuse(f'managed hard gate at commit: {mwhy}', {'ask_result': res, 'proposal_id': pid, 'attempt': attempt})
    lc = lifecycle_of(st); pend = lc.get(key)
    if not pend or pend.get('proposal_id') != pid: refuse('pending/proposal_id changed since ask', {'ask_result': res, 'proposal_id': pid, 'attempt': attempt})
    if lc['status'] != status0 or lc['status_generation'] != gen0: refuse(f'status/generation changed since ask ({status0}/{gen0} -> {lc["status"]}/{lc["status_generation"]})', {'ask_result': res, 'proposal_id': pid, 'attempt': attempt})
    mine = [x for x in pend['asks'] if x.get('attempt') == attempt]
    if len(mine) != 1 or mine[0].get('receipt') is not None: refuse('attempt entry missing or already receipted', {'ask_result': res, 'proposal_id': pid, 'attempt': attempt})
    mine[0]['receipt'] = dict(res, at=ts()); st['lifecycle'] = lc
    errs = pending_schema_errors('finish' if mode == 'finish' else 'reopen', pend, st)
    if errs or not managed_state(st)[0]: refuse(f'pending invalid at commit: {errs or managed_state(st)[1]}', {'ask_result': res, 'proposal_id': pid, 'attempt': attempt})
    rs = [r for r in journal(chat) if r.get('kind') == 'actor_receipt' and r.get('proposal_id') == pid and r.get('attempt') == attempt]
    if not rs: journal_append(chat, {'kind': 'actor_receipt', 'proposal_id': pid, 'attempt': attempt, 'payload': dict(res, ask_lark_app_id=app, at=ts())})
    write_state(chat, st)
print(json.dumps({'proposal_id': pid, 'attempt': attempt, 'result': res}, ensure_ascii=False))
