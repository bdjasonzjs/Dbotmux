#!/bin/bash
# observer 轮末入口（§2）：①journal/repair 重放收敛（任一失败 → 立即退出非 0，不进入 eval；r11：恢复/续做也过 managed 硬门——state 非 managed 时在途 plan/repair 只落 aborted/superseded 终态记录、零外写，本轮 exit 4，下一轮收敛）→ ②eval（写 plan / 建 repair）→ ③apply（config 决定 --apply；同轮 repair 在 mode=apply 时立即执行）→ ④audit（只写 wake_checked_at）
set -euo pipefail; D="$(cd "$(dirname "$0")" && pwd)"; CHAT=$1; cd "$D"
# Share the Python entrypoints' config path and scope reader, including
# P5_HOME / P5_CONFIG overrides. Missing scope is an error, never a fallback.
CFG=$(python3 -c 'from p5lib import CONFIG_PATH; print(CONFIG_PATH)')
export P5_CONFIG="$CFG"
AUTO_CHAT=$(python3 - "$CHAT" <<'PY'
import sys
from p5lib import delegation_scope
scope = delegation_scope('delegation_auto')
print('yes' if sys.argv[1] in scope['allowed_path'] else 'no')
PY
)
python3 - "$CHAT" <<'PY'
import sys, os
from p5core import *
chat = sys.argv[1]; fails = []
seen = []
for r in journal(chat):
    if r.get('kind') == 'plan' and r['plan_sha'] not in seen: seen.append(r['plan_sha'])
for sha in seen:
    last = journal_last(chat, sha)
    if last and last['phase'] not in ('committed', 'compensated', 'aborted'):
        p = os.path.join(p_plans(chat), sha + '.json')
        if not os.path.exists(p): fails.append(f'plan file missing for in-flight {sha[:16]}'); continue
        try:
            rc = apply_plan(p, do_apply=True)
            if rc != 0: fails.append(f'resume {sha[:16]} rc={rc}')
        except Exception as e: fails.append(f'resume {sha[:16]}: {e}')
if cfg().get('mode') == 'apply':
    for k in unresolved_repairs(chat):
        try:
            if execute_repair(chat, k) != 0: fails.append(f'repair {k[:16]} not converged')
        except Exception as e: fails.append(f'repair {k[:16]}: {e}')
if fails:
    print('ROUND-END ABORT (recovery not converged):', fails); sys.exit(4)
print('recovery ok')
PY
# Only configured nodes enter the existing callback; tick retains its enabled
# and manual-latch behavior. Recovery still precedes the callback.
if [ "$AUTO_CHAT" = yes ]; then
  python3 p5-task-auto.py tick "$CHAT"
fi
# ①b outbox 维护（r4 P1-3）：收到的决策登记 → ack 冒泡 → 父侧 ack 扫描 → 超时重放/告警；任一步失败 → 轮末非零，不进入 eval
set +e; OB=$(python3 p5-decision.py roundend-outbox "$CHAT"); obrc=$?; set -e; echo "outbox: $OB"
if [ "$obrc" -ne 0 ]; then echo "ROUND-END ABORT (outbox not converged) rc=$obrc"; exit 5; fi
OUT=$(mktemp); python3 p5-status-eval.py "$CHAT" --json > "$OUT"
python3 -c "import json; d=json.load(open('$OUT')); print(d['current'],'->',d['proposed'],d['reason'],'plan=',d.get('plan'),'repair=',(d.get('repair') or '')[:16])"
PLAN=$(python3 -c "import json; print(json.load(open('$OUT')).get('plan') or '')"); REPAIR=$(python3 -c "import json; print(json.load(open('$OUT')).get('repair') or '')")
MODE=$(python3 -c "import json; print(json.load(open('$CFG')).get('mode'))")
RC=0
if [ -n "$REPAIR" ] && [ "$MODE" = "apply" ]; then set +e; python3 p5-wake-apply.py --repair "$CHAT" "$REPAIR"; r=$?; set -e; echo "repair rc=$r"; if [ "$r" -ne 0 ]; then RC=$r; fi; fi
if [ -n "$PLAN" ]; then
  if python3 -c "import json,sys; c=json.load(open('$CFG')); sys.exit(0 if c.get('mode')=='apply' and '$CHAT' in c.get('apply_groups',[]) else 1)"; then
    set +e; python3 p5-wake-apply.py "$PLAN" --apply; r=$?; set -e; echo "apply rc=$r"; if [ "$r" -ne 0 ]; then RC=$r; fi
  else set +e; python3 p5-wake-apply.py "$PLAN"; r=$?; set -e; echo "dry-run rc=$r"; if [ "$r" -ne 0 ]; then RC=$r; fi; fi
fi
rm -f "$OUT"
set +e; python3 p5-observe.py --audit "$CHAT"; ar=$?; set -e
if [ "$ar" -ne 0 ]; then RC=$ar; fi
if [ "$RC" -ne 0 ]; then echo "ROUND-END FAILED rc=$RC（转换/修复未成功或审计不过；补偿成功也不算成功轮次）"; exit "$RC"; fi
exit 0
