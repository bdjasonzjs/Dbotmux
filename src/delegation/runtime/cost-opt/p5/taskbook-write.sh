#!/bin/bash
# taskbook-write.sh <chat> <new_content_file>：原子替换 taskbook、追加 index、用执行者 bot 身份在群里发公告 [p5:{taskbook_sha,gen}]
set -euo pipefail; cd "$(dirname "$0")"; CHAT=$1; SRC=$2
python3 - "$CHAT" "$SRC" <<'PY'
import sys, os, json, hashlib; from p5lib import *
chat, src = sys.argv[1:3]; data = open(src, 'rb').read(); sha = hashlib.sha256(data).hexdigest()
idx = [r for r in read_jsonl(p_tbindex()) if r.get('chat') == chat]; gen = (idx[-1]['gen'] + 1) if idx else 1
atomic_write(p_taskbook(chat), data)
append_fsync(p_tbindex(), {'chat': chat, 'sha': sha, 'gen': gen, 'writer_session': os.environ.get('BOTMUX_SESSION_ID'), 'writer_app': os.environ.get('BOTMUX_LARK_APP_ID'), 'at': ts()})
mk = encode_marker({'taskbook_sha': sha, 'gen': gen})
mid = send_message(chat, f'任务书已更新 gen={gen} {mk}', as_user=False)
print(json.dumps({'sha': sha, 'gen': gen, 'announce': mid}))
PY
