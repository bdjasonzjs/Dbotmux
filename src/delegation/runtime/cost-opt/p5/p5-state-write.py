#!/usr/bin/env python3
"""p5-state-write.py <chat> --set <path> <json_value> [...]   业务字段锁内局部更新、原子写；
   --lifecycle-bookkeeping <path> <json_value>                 簿记写（白名单）。
规则：任何 lifecycle.* 路径在普通模式下拒绝；凡触及 tasks（整表、单节点或子字段），写入后对**每个**终态/人类节点重新做证据校验（§3.2），任一不过 → 整次拒写。"""
import sys, json, os, datetime; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
chat = sys.argv[1]; args = sys.argv[2:]
def validate_all_tasks(chat, st):
    tasks = st.get('tasks') or {}
    if not isinstance(tasks, dict): raise SystemExit('REJECT tasks must be an object')
    need = {tid: t for tid, t in tasks.items() if isinstance(t, dict) and (t.get('status') in ('done', 'void') or t.get('kind') == 'human')}
    for tid, t in tasks.items():
        if isinstance(t, dict) and str(t.get('blocked_on', '')) == 'owner': raise SystemExit(f'REJECT {tid}: blocked_on=owner not allowed (use taskbook human node)')
    if not need: return
    msgs = list_messages(chat, start=now() - datetime.timedelta(hours=48)); tb = taskbook_status(chat, msgs)
    cls = classify_tasks(chat, st, msgs, tb, role_apps_for(st))
    for tid, t in need.items():
        want = 'terminal' if t.get('status') in ('done', 'void') else 'owner_blocked'
        if cls.get(tid, {}).get('cls') != want: raise SystemExit(f'REJECT {tid}: evidence check failed ({cls.get(tid, {}).get("why")})')
i = 0
with ChatLock(chat):
    st = read_state(chat)
    if st is None: raise SystemExit('state missing')
    touched_tasks = False
    while i < len(args):
        op = args[i]
        if op == '--set':
            path, val = args[i + 1], json.loads(args[i + 2]); i += 3
            if path == 'lifecycle' or path.startswith('lifecycle.'): raise SystemExit('REJECT lifecycle path in business write')
            if path == 'tasks' or path.startswith('tasks.'): touched_tasks = True
            set_path(st, path, val)
        elif op == '--lifecycle-bookkeeping':
            path, val = args[i + 1], json.loads(args[i + 2]); i += 3
            if not any(path == a or path.startswith(a + '.') for a in BOOKKEEPING_ALLOW): raise SystemExit(f'REJECT bookkeeping path {path}')
            mok, mwhy = managed_state(st)
            if not mok: raise SystemExit(f'REJECT bookkeeping on non-managed state ({mwhy})')
            lc = lifecycle_of(st); set_path(lc, path, val); st['lifecycle'] = lc
        else: raise SystemExit(f'unknown op {op}')
    if touched_tasks: validate_all_tasks(chat, st)  # 所有 mode 一律 fail-closed（v7 §3.2：缺一项即拒写；r3 P1-1）
    st['updated_at'] = now().strftime('%Y-%m-%d %H:%M'); write_state(chat, st)
print('ok')
