#!/usr/bin/env python3
"""p5-status-eval.py <chat> [--json]：锁内评估；proposed≠current 或需清 pending → 原子写 plan（或建 repair）。只读业务事实。"""
import sys, json, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5core import eval_and_plan
chat = sys.argv[1]; out = eval_and_plan(chat)
if '--json' in sys.argv: print(json.dumps(out, ensure_ascii=False, indent=1))
else:
    print(f"{out['current']} -> {out['proposed']} ({out['reason']}) plan={out.get('plan')} repair={out.get('repair','')[:16] if out.get('repair') else ''}")
    for g in out['guards']: print(('  ✅ ' if g['pass'] else '  ❌ ') + g['guard'] + ('  ' + g['why'] if g['why'] else ''))
