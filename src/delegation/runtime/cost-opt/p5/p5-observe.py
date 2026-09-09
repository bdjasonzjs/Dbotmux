#!/usr/bin/env python3
"""p5-observe.py --audit [chat] | --emit-repair-intent <chat> | --repair-open
--audit：不改 wake/status/generation，仅写 wake_checked_at；任何 state/journal/repairs 解析错误或不变式违反 → exit 非 0。"""
import sys, os, json; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5core import audit, emit_repair, repair_open_all, all_chats
a = sys.argv[1:]
if a[0] == '--audit':
    bad = 0
    try: chats = [a[1]] if len(a) > 1 else all_chats(strict=True)
    except Exception as e: print(json.dumps({'error': str(e)})); sys.exit(1)
    for c in chats:
        try:
            r = audit(c); print(json.dumps(r, ensure_ascii=False))
            if r['lifecycle_present'] and not r['invariant_ok']: bad += 1
        except Exception as e: print(json.dumps({'chat': c, 'error': str(e)})); bad += 1
    sys.exit(1 if bad else 0)
if a[0] == '--emit-repair-intent': print(emit_repair(a[1]) or 'no drift'); sys.exit(0)
if a[0] == '--repair-open':
    errs = repair_open_all(); print('errors:', errs); sys.exit(1 if errs else 0)
print(__doc__); sys.exit(1)
