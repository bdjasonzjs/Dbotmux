#!/usr/bin/env python3
"""p5-wake-apply.py <plan_path> [--apply]  |  --repair <chat> <repair_key>  |  --plan-resume <plan_path>
exit: 0 ok/dry-run/幂等；2 硬门拒绝（不写 journal 不动 wake）；3 动作/提交失败已补偿或已建 repair。"""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5core import apply_plan, execute_repair, GateFail
a = sys.argv[1:]
try:
    if a and a[0] == '--repair': sys.exit(execute_repair(a[1], a[2]))
    sys.exit(apply_plan(a[0], do_apply=('--apply' in a)))
except GateFail as e:
    print('GATE REFUSED:', e); sys.exit(2)
