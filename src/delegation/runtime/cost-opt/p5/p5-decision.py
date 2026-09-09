#!/usr/bin/env python3
"""outbox（§4.3）
  p5-decision.py propose <parent> <child> <task_id> <basis_json> <exec_ou> <text_file>  → 唯一创建入口：父子拓扑+执行者登记绑定 → 校 basis（结构化 bot_message{ref,node,round,role,verdict} 逐字段绑定 marker/角色 app/taskbook gen，或 ask_pending 已落盘记录）→ 固定 payload 单文件（原始 UTF-8 bytes 口径）→ 锁内写 pending（锚点）→ 才打印 decision_id；out-pending 已退役(rc 9)
  p5-decision.py dispatch <parent> <decision_id> [<exec_ou> <text_file>]  → 以 state entry 锚点为根核 payload；发送后按精确 message_id 回读核 sender/marker/正文/mentions 含执行者，否则不写 .sent(rc 6)
  p5-decision.py dispatch <parent> <decision_id> <child_executor_ou> <text_file>  → per-decision 锁 + 分页查重 + receipt + 发送
  p5-decision.py in-record <child> <decision_id> <message_id>          → 子侧登记（去重）+ ack 冒泡 outbox
  p5-decision.py ack <parent> <decision_id> <ack_message_id>          → 父侧 acked（早到 → in_early）
  p5-decision.py check-unacked <parent>                               → pending/sending >10min 重放同 id（分页查重，不重复发）；sent >2h 未 ack 去重告警；terminal 归档
  p5-decision.py bubble-flush <child>                                 → 子侧 bubbles.out 的 ack：pending→sending→sent，向父群投递 [p5:{ack}] marker（receipt 化、查重）
  p5-decision.py ack-scan <parent>                                    → 父侧扫父群消息里的 ack marker → acked
  p5-decision.py in-scan <child>                                     → 子侧扫本群 owner 身份发的决策 marker，绑定父 outbox receipt（sent_message_id==本消息）才登记 + 建 ack bubble
  p5-decision.py roundend-outbox <chat>                              → 轮末 fail-closed 顺序：decision in-scan → task-event ingest → bubble-flush → ack-scan → check-unacked
  lease：<did>.lock 内容 pid+时间；flock 失败=busy；拿到 flock 后若 lease 持有者 pid 仍活且 age<15min 也判 busy（rc 4）；死 pid 或 >15min → takeover 并记账"""
import sys, os, json, uuid, datetime, fcntl, subprocess, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
def tstr_of(d): return d.strftime('%Y-%m-%d %H:%M:%S')
a = sys.argv[1:]; op = a[0]
def outbox_entries(lc, kind='out'): return lc['decisions'].setdefault(kind, [])
def payload_path(parent, did):
    ob = p_outbox(parent); os.makedirs(ob, exist_ok=True); return ob, os.path.join(ob, did + '.payload.json')
def state_entry(parent, did):
    st = read_state(parent); ent = [e for e in outbox_entries(lifecycle_of(st)) if e['decision_id'] == did]; return ent[0] if ent else None
def load_payload(parent, did, ent=None):
    """以 parent state entry 为根：payload 文件的 body_sha/exec_ou 必须 == entry，且 sha256(body)==body_sha；任一不符 → rc 8（零外发、零 state 写）。返回 (exec_ou, body, body_sha)。"""
    ent = ent or state_entry(parent, did)
    if not ent: print('unknown decision'); sys.exit(1)
    if not ent.get('body_sha') or not ent.get('exec_ou'): print('decision has no proposal-fixed payload anchor (legacy/no-payload pending): unrecoverable, re-propose'); sys.exit(7)
    ob, pp = payload_path(parent, did)
    if not os.path.exists(pp): print('payload file missing for anchored decision: unrecoverable, re-propose'); sys.exit(8)
    try: pl = json.load(open(pp, encoding='utf-8'))
    except Exception as e: print(f'payload file unreadable: {e}'); sys.exit(8)
    body = pl.get('body'); bsha = sha256b((body or '').encode('utf-8'))
    if not isinstance(body, str) or pl.get('body_sha') != bsha or pl.get('exec_ou') != ent['exec_ou'] or bsha != ent['body_sha'] or pl.get('decision_id') != did or pl.get('chain') != ent.get('chain'):
        print(json.dumps({'error': 'payload does not match proposal anchor in parent state (rc 8, no send, no state write)', 'anchor': {'body_sha': ent['body_sha'], 'exec_ou': ent['exec_ou']}, 'file': {'body_sha': pl.get('body_sha'), 'exec_ou': pl.get('exec_ou'), 'actual_body_sha': bsha}})); sys.exit(8)
    return ent['exec_ou'], body, bsha
def envelope_marker(did, exec_ou, body_sha): return encode_marker({'decision_id': did, 'body_sha': body_sha, 'exec_ou': exec_ou})
def expected_text(did, exec_ou, body, body_sha=None):
    body_sha = body_sha or sha256b(body.encode('utf-8')); return f'<at user_id="{exec_ou}">执行者</at> {envelope_marker(did, exec_ou, body_sha)} {body}'
def consume_mention_prefix(txt, ment, expected_ou=None):
    """只消费正文开头、与唯一 mentions[0] 对应的那一个 mention token（三种渲染之一）；不做任何全局替换。返回剩余正文或 None。"""
    s = txt.lstrip(' \t')
    cands = [f'<at user_id="{ment.get("id")}">']
    if expected_ou: cands.append(f'<at user_id="{expected_ou}">')
    if ment.get('key'): cands.append(ment['key'])
    if ment.get('name'): cands.append('@' + ment['name'])
    for c in cands:
        if s.startswith(c):
            if c.startswith('<at '):
                e = s.find('</at>')
                if e < 0: return None
                return s[e + len('</at>'):]
            return s[len(c):]
    return None
def message_valid(m, did, exec_ou, body, body_sha=None):
    """canonical envelope 精确核验：owner 身份发 ∧ mentions 恰好一个且 id==exec_ou ∧ 正文 = [该 mention token][空白][唯一 canonical marker {decision_id,body_sha,exec_ou}][一个空格][body 逐字]。
    只消费固定位置的单个 mention token 与单个 marker，正文其余部分逐字比较（不做全局 replace / at-tag 正则删除）。"""
    body_sha = body_sha or sha256b(body.encode('utf-8'))
    owner = owner_id_for_app(m.get('_reader_app_id') or cfg().get('lark_bot_app') or executor_app())
    s = m.get('sender', {})
    if not owner or s.get('sender_type') != 'user' or s.get('id') != owner: return False, 'sender not owner identity in actual reader view'
    ments = [x for x in (m.get('mentions') or []) if isinstance(x, dict)]
    allowed_targets={exec_ou}
    cs=read_state(m.get('chat_id')) if m.get('chat_id') else None
    if cs and child_executor(cs)[0]==exec_ou:
        app=role_apps_for(cs).get('executor')
        if app: allowed_targets.add(app)
    if len(ments) != 1 or ments[0].get('id') not in allowed_targets: return False, f'mentions must be exactly one registered executor {exec_ou}, got {[x.get("id") for x in ments]}'
    # F1 (r20)：读回失败必须以「读回失败」的名义拒绝，而不是让回退空正文伪装成 marker 数错误。
    # msg_text 的 fail-closed 回退保留（事实层不因补水 traceback），但 _quoted_error 在此被消费。
    txt = msg_text(m)
    if m.get('_quoted_error'): return False, f"binding readback failed, rejecting on fallback body: {m['_quoted_error']}"
    raw = MARK_RE.findall(txt or '')
    if len(raw) != 1: return False, f'expected exactly one p5 marker in whole message, got {len(raw)}'
    mk = find_markers(txt)
    if len(mk) != 1 or mk[0] != {'decision_id': did, 'body_sha': body_sha, 'exec_ou': exec_ou}: return False, 'marker is not the canonical envelope {decision_id, body_sha, exec_ou}'
    rest = consume_mention_prefix(txt, ments[0],exec_ou)
    if rest is None: return False, 'mention token not at envelope position'
    rest = rest.lstrip(' \t'); tok = '[p5:' + raw[0] + ']'
    if not rest.startswith(tok): return False, 'marker not immediately after mention token'
    rest = rest[len(tok):]
    if not rest.startswith(' '): return False, 'missing single separator after marker'
    rest = rest[1:]
    if rest == body: return True, ''
    if rest == body.rstrip('\r\n') and body != body.rstrip('\r\n'): return True, 'trailing newline normalized by platform'
    return False, 'body not byte-exact after consuming the single envelope (extra/missing text)'
def readback_message(chat, mid, since):
    msgs = list_messages(chat, start=since)  # fail-closed 分页到边界
    for m in msgs:
        if m.get('message_id') == mid: return m
    return None
def scan_text(m, stage):
    """Reuse this query's hydrated message; a failed read is not a marker miss.

    No second per-card read in the scan/validation pair. A command retry obtains
    new message objects from list_messages and retries their original read.
    """
    try:
        text = msg_text(m)
        if m.get('_quoted_error'): raise RuntimeError(m['_quoted_error'])
        return text
    except Exception as e:
        print(f'{stage} body readback failed, not sending/advancing: message_id={m.get("message_id")} error={e}')
        sys.exit(5)
def validate_basis(parent, child, basis, task_id):
    """v7 §3.1/§4.3：basis 必须是结构化机器证据。
    bot_message = {kind, ref, node, round, role, verdict}：ref 在父群 48h 内读回；sender 为 app 且 == role_apps[role]；正文里匹配 (node,round,role) 的 marker 恰好一个、verdict 逐字等于且 ∈ {done, PASS}（NOT PASS 否决）；父 taskbook 有效（index sha + 执行者公告）且 node 是结构化节点、消息晚于节点 created；绑定当前 taskbook_gen。
    ask_pending = {kind, ref}：ref 为父 lifecycle finish_pending/reopen_pending 已落盘记录。其余一律拒。返回规范化 basis。"""
    if not isinstance(basis, dict) or basis.get('kind') not in ('bot_message', 'ask_pending') or not basis.get('ref'): raise ValueError('basis must be {kind: bot_message|ask_pending, ref, ...}')
    if basis['kind'] == 'bot_message':
        for k in ('node', 'round', 'role', 'verdict'):
            if basis.get(k) in (None, ''): raise ValueError(f'bot_message basis missing field {k}')
        if basis['verdict'] not in ('done', 'PASS'): raise ValueError(f'basis verdict must be done|PASS, got {basis["verdict"]}')
        exp_app = role_apps_for(parent).get(basis['role'])
        if not exp_app: raise ValueError(f'unknown role {basis["role"]}')
        msgs = list_messages(parent, start=now() - datetime.timedelta(hours=48))
        m = next((x for x in msgs if x.get('message_id') == basis['ref']), None)
        if not m: raise ValueError('basis message not found in parent chat (48h)')
        s = m.get('sender', {})
        if s.get('sender_type') != 'app' or s.get('id_type') != 'app_id' or s.get('id') != exp_app: raise ValueError(f'basis message sender {s.get("id")} is not the {basis["role"]} app {exp_app}')
        # Basis evidence is authorization, not a display hydration cache. Keep
        # every marker/role/time rule below, but require a fresh bound card read.
        text = taskbook_message_text(m)
        allm = find_markers(text); rawn = len(MARK_RE.findall(text or ''))
        if rawn != 1 or len(allm) != 1: raise ValueError(f'basis message must carry exactly one canonical marker, got {rawn}')
        k = allm[0]
        if k != {'node': basis['node'], 'round': basis['round'], 'role': basis['role'], 'verdict': basis['verdict']}: raise ValueError(f'marker fields differ from basis (marker={k})')
        tb = taskbook_status(parent, msgs)
        if not tb.get('valid'): raise ValueError(f'parent taskbook invalid: {tb.get("reason")}')
        if basis.get('taskbook_sha') != tb['sha'] or basis.get('taskbook_gen') != tb['gen']: raise ValueError(f'basis taskbook_sha/gen must equal current valid taskbook (sha {tb["sha"][:12]} gen {tb["gen"]})')
        ann = next((x for x in msgs if x.get('message_id') == tb.get('announce')), None)
        if not ann or not msg_later(m, ann, msgs): raise ValueError('basis message must be later than the taskbook announcement of this sha/gen')
        nodes = taskbook_nodes(parent); nd = nodes.get(basis['node'])
        if not nd: raise ValueError(f'node {basis["node"]} not a structured taskbook node')
        pair = {'review': ('review', 'reviewer'), 'worker': ('worker', 'executor')}
        if nd.get('kind') not in pair or basis['role'] not in pair[nd['kind']]: raise ValueError(f'node kind {nd.get("kind")} does not pair with basis role {basis["role"]}')
        if nd.get('kind') == 'review' and basis['verdict'] != 'PASS': raise ValueError('review node evidence must be verdict PASS')
        if nd.get('kind') == 'worker' and basis['verdict'] != 'done': raise ValueError('worker node evidence must be verdict done')
        if (short(child), task_id) not in edge_targets(nd): raise ValueError(f'({short(child)}, {task_id}) is not an explicit next=<child>:<task> edge of node {basis["node"]} (next={nd.get("next")})')
        try: c0 = datetime.datetime.strptime(nd.get('created'), '%Y-%m-%d %H:%M').replace(tzinfo=BJ)
        except Exception: raise ValueError('node created time unparsable')
        if msg_time(m) <= c0: raise ValueError('basis message not later than node creation')
        return {'kind': 'bot_message', 'ref': basis['ref'], 'chat': parent, 'app_id': s['id'], 'node': basis['node'], 'node_kind': nd['kind'], 'round': basis['round'], 'role': basis['role'], 'verdict': basis['verdict'], 'edge': f'{basis["node"]}->{short(child)}:{task_id}', 'edge_child': child, 'taskbook_sha': tb['sha'], 'taskbook_gen': tb['gen'], 'announce': tb.get('announce'), 'created_at': msg_time(m).strftime('%Y-%m-%d %H:%M:%S')}
    lc = lifecycle_of(read_state(parent) or {}); found = False
    for block in (lc.get('finish_pending'), lc.get('reopen_pending')):
        if isinstance(block, dict):
            if block.get('proposal_id') == basis['ref']: found = True
            for a_ in block.get('asks') or []:
                if isinstance(a_, dict) and (a_.get('proposal_id') == basis['ref'] or a_.get('ask_id') == basis['ref']): found = True
    if not found: raise ValueError('ask_pending ref not found in parent lifecycle finish_pending/reopen_pending')
    return {'kind': 'ask_pending', 'ref': basis['ref']}
def edge_targets(nd):
    """节点显式下行边：next=<child_chat|child_short>:<task_id>[,…] → {(child_short, task_id)}；不带 child 的旧写法不算边。"""
    out = set()
    for x in (nd.get('next') or '').split(','):
        x = x.strip()
        if ':' not in x: continue
        c, task = x.split(':', 1)
        if c.startswith('oc_') and task: out.add((short(c), task))
    return out
def child_executor(child_state):
    """子群执行者的结构化登记：state.executor_ou（bootstrap 从类型模板「本群执行者」行写入），缺省再按 state.type 读模板。"""
    tp = child_state.get('type'); tf = os.path.join(P5_HOME, 'templates', f'{tp}.md') if tp else None
    if tf and os.path.exists(tf):
        mm = re.search(r'本群执行者\s*=\s*\*\*[^*]+\*\*\s*[（(]\s*(ou_[0-9A-Za-z]+)', open(tf, encoding='utf-8').read())
        if mm:
            if child_state.get('executor_ou') and child_state['executor_ou']!=mm.group(1): return None,'executor template/instance mismatch'
            return mm.group(1), f'templates/{tp}.md'
    if child_state.get('executor_ou'): return child_state['executor_ou'], 'state.executor_ou'
    return None, None
if op == 'out-pending':
    print('REJECT: out-pending retired; use `propose <parent> <child> <task_id> <basis_json> <exec_ou> <text_file>` (payload + machine-evidence basis are mandatory; no-payload pending is not a legal state)'); sys.exit(9)
elif op == 'propose':
    # 唯一生产创建入口：①校验 basis（机器证据读回）②固定 payload 单文件（原子）③锁内写 pending（含 body_sha/exec_ou/basis）④才打印 decision_id。任一步失败 → 非零、不落 pending。
    parent, child, task = a[1], a[2], a[3]; exec_ou, tf = a[5], a[6]
    # 父子拓扑 + 执行者登记绑定（在任何落盘之前）
    pst = read_state(parent); cst = read_state(child)
    for nm, s_ in (('parent', pst), ('child', cst)):
        ok_, why_ = managed_state(s_)
        if not ok_: print(f'REJECT topology: {nm} not managed ({why_})'); sys.exit(9)
    if child not in (pst.get('children') or []) or cst.get('parent') != parent: print(f'REJECT topology: child not registered under parent (parent.children / child.parent mismatch)'); sys.exit(9)
    reg_ou, reg_src = child_executor(cst)
    if not reg_ou: print('REJECT executor: child has no structured executor registration (state.executor_ou / type template)'); sys.exit(9)
    if exec_ou != reg_ou: print(f'REJECT executor: {exec_ou} is not the registered executor of child ({reg_ou} from {reg_src})'); sys.exit(9)
    try: basis = validate_basis(parent, child, json.loads(a[4]), task)
    except Exception as e: print(f'REJECT basis: {e}'); sys.exit(9)
    chain = None
    if os.environ.get('P5_CHAIN_META_JSON'):
        try: chain = json.loads(os.environ['P5_CHAIN_META_JSON'])
        except Exception as e: print(f'REJECT chain meta JSON: {e}'); sys.exit(9)
        if set(chain) != {'root_request_id', 'task_id', 'task_version', 'parent_delivery_id'}: print('REJECT chain meta fields'); sys.exit(9)
        if not isinstance(chain['root_request_id'], str) or not re.fullmatch(r'om_[0-9A-Za-z]+', chain['root_request_id']): print('REJECT chain root_request_id'); sys.exit(9)
        if chain['task_id'] != task: print('REJECT chain task_id differs from propose task'); sys.exit(9)
        if not isinstance(chain['task_version'], int) or chain['task_version'] < 1: print('REJECT chain task_version'); sys.exit(9)
        if chain['parent_delivery_id'] is not None and (not isinstance(chain['parent_delivery_id'], str) or not re.fullmatch(r'om_[0-9A-Za-z]+', chain['parent_delivery_id'])): print('REJECT chain parent_delivery_id'); sys.exit(9)
    guard=task_chain_guard(parent,child,task,chain)
    if guard: print('REJECT chain: '+guard); sys.exit(9)
    if not os.path.isfile(tf): print('REJECT: text_file must exist'); sys.exit(9)
    raw = open(tf, 'rb').read()  # 正文口径 = 原始 UTF-8 bytes（保留 CRLF/末尾换行），全链路只认这一份 bytes 的 sha
    try: body = raw.decode('utf-8')
    except Exception: print('REJECT: text_file is not valid UTF-8'); sys.exit(9)
    if not body.strip(): print('REJECT: empty body'); sys.exit(9)
    if chain and any(x not in body for x in version_contract_text(task_binding(pst,task))):
        print('REJECT version body lacks migration/document binding'); sys.exit(9)
    if chain and (chain['root_request_id'] not in body or task not in body or not re.search(r'(?:任务书版本|task_version|版本)\s*[=:：]?\s*`?'+str(chain['task_version'])+r'\b',body)):
        print('REJECT chain body lacks root/task/exact version'); sys.exit(9)
    pid = str(uuid.uuid4()); did = sha256b(f'{parent}|{child}|{task}|{pid}'.encode()); bsha = sha256b(raw)
    with AuthLocks(parent,child):
        st = read_state(parent); lc = lifecycle_of(st)
        guard=task_chain_guard(parent,child,task,chain)
        if guard: print('REJECT chain before proposal commit: '+guard); sys.exit(9)
        if chain:
            hits=[e for e in outbox_entries(lc) if e.get('to')==child and e.get('task_id')==task and e.get('chain') and e['chain'].get('root_request_id')==chain['root_request_id'] and e['chain'].get('task_version')==chain['task_version'] and e.get('state')!='cancelled']
            if len(hits)>1: print('REJECT duplicate live chain decisions already exist'); sys.exit(9)
            if hits:
                old=hits[0]
                if old.get('exec_ou')!=exec_ou or old.get('body_sha')!=bsha or old.get('chain')!=chain: print('REJECT same chain request has conflicting immutable payload/metadata'); sys.exit(9)
                load_payload(parent,old['decision_id'],old)
                print(old['decision_id']); sys.exit(0)
        ob, pp = payload_path(parent, did); atomic_write(pp, json.dumps({'decision_id': did, 'exec_ou': exec_ou, 'body_sha': bsha, 'body': body, 'chain': chain, 'fixed_at': ts()}, ensure_ascii=False).encode('utf-8'))
        try: os.chmod(pp, 0o444)
        except Exception: pass
        outbox_entries(lc).append({'decision_id': did, 'proposal_id': pid, 'to': child, 'task_id': task, 'basis': basis, 'chain': chain, 'exec_ou': exec_ou, 'executor_registry': reg_src, 'child_generation': lifecycle_of(cst).get('status_generation'), 'body_sha': bsha, 'state': 'pending', 'pending_at': ts()})
        st['lifecycle'] = lc; write_state(parent, st)
    print(did)
def pid_alive(pid):
    try: os.kill(int(pid), 0); return True
    except Exception: return False
def acquire_lease(ob, did):
    lockp = os.path.join(ob, did + '.lock'); fd = os.open(lockp, os.O_RDWR | os.O_CREAT, 0o644)
    try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        try: pid_s, at_s = open(lockp).read().strip().split(' ', 1)
        except Exception: pid_s, at_s = '0', ''
        print(f'busy: another sender holds the decision lock (pid {pid_s} since {at_s})'); sys.exit(4)
    # lease 契约（v7 §4.3 / P2）：持有者 pid 仍活且 age<15min → busy；死 pid 或 age≥15min → takeover（记账）
    try: pid_s, at_s = open(lockp).read().strip().split(' ', 1)
    except Exception: pid_s, at_s = None, None
    if pid_s and pid_s != str(os.getpid()):
        age = None
        try: age = (now() - datetime.datetime.strptime(at_s, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)).total_seconds()
        except Exception: pass
        if pid_alive(pid_s) and age is not None and age < 900:
            print(f'busy: live lease holder pid {pid_s} age {int(age)}s < 900s'); sys.exit(4)
        print(json.dumps({'lease_takeover': {'from_pid': pid_s, 'since': at_s, 'age_sec': None if age is None else int(age), 'alive': pid_alive(pid_s)}}))
    os.ftruncate(fd, 0); os.write(fd, f'{os.getpid()} {ts()}\n'.encode()); os.fsync(fd); return fd
def taskbook_version_ok(parent, basis):
    tbp = p_taskbook(parent)
    if not os.path.exists(tbp): return False, 'taskbook missing'
    fsha = sha256b(open(tbp, 'rb').read())
    if fsha != basis.get('taskbook_sha'): return False, f'file sha {fsha[:12]} != proposal anchor {str(basis.get("taskbook_sha"))[:12]}'
    idx = [r for r in read_jsonl(p_tbindex()) if r.get('chat') == parent]
    if not idx: return False, 'no index'
    if idx[-1].get('sha') != fsha: return False, 'file sha != index (unregistered direct edit)'
    if idx[-1].get('gen') != basis.get('taskbook_gen'): return False, f'index gen {idx[-1].get("gen")} != proposal anchor {basis.get("taskbook_gen")}'
    return True, ''
def auth_epoch(parent, ent):
    """授权纪元 = 拓扑/执行者/生命周期/taskbook 边 的 canonical 投影的 sha256；任何相关写入都会改变它。"""
    child = ent['to']; pst = read_state(parent) or {}; cst = read_state(child) or {}
    nodes = taskbook_nodes(parent); b = ent.get('basis') or {}; nd = nodes.get(b.get('node')) if b.get('kind') == 'bot_message' else None
    edge_ok = (b.get('kind') != 'bot_message') or (nd is not None and (short(child), ent['task_id']) in edge_targets(nd))
    tbp = p_taskbook(parent); tbsha = sha256b(open(tbp, 'rb').read()) if os.path.exists(tbp) else None
    proj = {'parent_children_has': child in (pst.get('children') or []), 'child_parent': cst.get('parent'), 'executor': child_executor(cst)[0], 'child_status': lifecycle_of(cst).get('status'), 'child_gen': lifecycle_of(cst).get('status_generation'), 'edge_ok': edge_ok, 'taskbook_sha': tbsha,
            'parent_task_auth':auth_projection(pst),'child_task_auth':auth_projection(cst),'chain_guard':task_chain_guard(parent,child,ent['task_id'],ent.get('chain'))}
    return sha256b(canonical(proj).encode()), proj
def generation_path_ok(child, g0, g1):
    """证明 child 从 g0 到 g1 的每一步都是已提交的 active↔paused 转换（journal/repairs 的 state_write_intent.postimage + state_committed 同代）；缺任一代记录或任一步进入 finished/unmanaged → 不可证明。"""
    if g0 is None or g1 is None or g1 == g0: return True, 'same generation'
    if g1 < g0: return False, 'generation regressed'
    seen = {}
    for src in (p_journal(child), p_repairs(child)):
        rows = read_jsonl(src); pend = {}
        for r in rows:
            key = r.get('plan_sha') or r.get('repair_key'); ph = r.get('phase'); pl = r.get('payload') or {}
            if ph == 'state_write_intent' and isinstance(pl.get('postimage'), dict): pend[key] = pl['postimage']
            if ph == 'state_committed' and key in pend and pl.get('generation') == pend[key].get('status_generation'): seen[pl['generation']] = pend[key].get('status')
    for g in range(g0 + 1, g1 + 1):
        s = seen.get(g)
        if s is None: return False, f'generation {g} has no committed transition record'
        if s not in ('active', 'paused'): return False, f'generation {g} transitioned to {s}'
    return True, f'generations {g0+1}..{g1} are committed active/paused transitions'
def authorization_drift(parent, ent):
    """dispatch/重放/查重/receipt 恢复前（per-decision 锁内）重验授权。兼容谓词：parent.children ∋ child ∧ child.parent == parent ∧ 当前登记执行者 == entry.exec_ou ∧ child.status ∈ {active, paused} ∧ generation 不倒退；
    generation 前进（active↔paused 翻转会 bump）视为兼容并在发送时记录；拓扑/执行者任一变化或 status 进入 finished/unmanaged → 作废。返回漂移原因或 None。"""
    child = ent['to']; pst = read_state(parent); cst = read_state(child)
    guard=task_chain_guard(parent,child,ent['task_id'],ent.get('chain'))
    if guard: return guard
    for nm, s_ in (('parent', pst), ('child', cst)):
        ok_, why_ = managed_state(s_)
        if not ok_: return f'{nm} not managed ({why_})'
    if child not in (pst.get('children') or []): return 'child no longer in parent.children'
    if cst.get('parent') != parent: return f'child.parent is now {str(cst.get("parent"))[:11]}'
    reg, src = child_executor(cst)
    if not reg or reg != ent.get('exec_ou'): return f'child executor registration is now {reg} (was {ent.get("exec_ou")})'
    clc = lifecycle_of(cst)
    if clc.get('status') not in ('active', 'paused'): return f'child status is {clc.get("status")}'
    b = ent.get('basis') or {}
    if b.get('kind') == 'bot_message':
        # taskbook 版本锚：当前文件 sha == basis.taskbook_sha == index 最新 sha，且 index gen == basis.taskbook_gen；换代/未登记直改（同边仍在也）→ 漂移
        ok_, why_ = taskbook_version_ok(parent, b)
        if not ok_: return f'taskbook version drift: {why_}'
        nd = taskbook_nodes(parent).get(b.get('node'))
        if nd is None or (short(child), ent['task_id']) not in edge_targets(nd): return f'taskbook edge {b.get("node")}->{short(child)}:{ent["task_id"]} revoked'
    g0 = ent.get('child_generation'); g1 = clc.get('status_generation')
    ok, why = generation_path_ok(child, g0, g1)
    if not ok: return f'child generation {g0}->{g1} not provably active/paused-only: {why}'
    return None
def _hook(name):
    cmd = os.environ.get(name)
    if cmd: subprocess.run(cmd, shell=True)
def do_dispatch(parent, did, exec_ou=None, tf=None, replay=False):
    ob, pp = payload_path(parent, did); fd = acquire_lease(ob, did)
    ent0 = state_entry(parent, did)
    if not ent0: print('unknown decision'); sys.exit(1)
    if ent0['state'] in ('acked', 'cancelled'): print(json.dumps({'decision_id': did, 'state': ent0['state'], 'dedup': 'terminal'})); return 0
    if ent0['state'] == 'delivery_indeterminate':
        # 外写可能已发生：不重发、不作废，等 receipt/ack 对账（ack-scan 命中即 acked）；人工确认后可 out-record/cancel
        print(json.dumps({'decision_id': did, 'state': 'delivery_indeterminate', 'message_id': ent0.get('sent_message_id'), 'note': 'awaiting receipt/ack reconciliation; no resend, no cancel'})); sys.exit(7)
    child = ent0['to']
    def update_parent(fn):
        st = read_state(parent); lc = lifecycle_of(st)
        for e in outbox_entries(lc):
            if e['decision_id'] == did: fn(e, lc)
        st['lifecycle'] = lc; write_state(parent, st)
    def cancel(why, rc=9):
        def f(e, lc):
            if e['state'] not in ('acked',): e['state'] = 'cancelled'; e['cancel_reason'] = why; e['cancelled_at'] = ts()
        update_parent(f); record_claim(did, parent, child, None, phase='cancelled', reason=why)
        ledger_line(parent, f'下行决策 {did[:12]} 已作废（授权漂移：{why}）'); print(json.dumps({'error': 'authorization drift; decision cancelled, no send', 'why': why})); sys.exit(rc)
    with AuthLocks(parent, child):  # 线性化：claim → 重验 → 查重 → 发送 → 纪元核对 → finalize 全程持有 parent+child state 锁；所有 P5 写者经 write_state 改动授权投影会 supersede 在途 claim
        ent = state_entry(parent, did)
        active=task_binding(read_state(parent),ent.get('task_id')) or {}
        if active.get('migration_id') and (ent.get('chain') or {}).get('task_version',0)<active['task_version']:
            print(json.dumps({'error':'obsolete version; historical decision/payload/receipt retained, no send','decision_id':did})); sys.exit(9)
        why = authorization_drift(parent, ent)
        if why: cancel(why)
        E1, proj1 = auth_epoch(parent, ent)
        p_exec, body, bsha = load_payload(parent, did, ent)  # 根 = state entry；不符 rc 8
        if exec_ou is not None and exec_ou != p_exec: print(json.dumps({'error': 'exec_ou differs from proposal anchor (rc 8)', 'anchor': p_exec, 'given': exec_ou})); sys.exit(8)
        if tf is not None and sha256b(open(tf, 'rb').read()) != bsha: print(json.dumps({'error': 'text differs from proposal anchor (rc 8)', 'anchor_body_sha': bsha})); sys.exit(8)
        exec_ou = p_exec
        boundary = datetime.datetime.strptime(ent['pending_at'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ) - datetime.timedelta(minutes=10)
        def epoch_intact(stage):
            E, proj = auth_epoch(parent, state_entry(parent, did)); oc = open_claims(child)
            if E != E1: return False, f'{stage}: authorization epoch changed ({[k for k in proj if proj[k] != proj1.get(k)]})'
            if did not in oc or did not in open_claims(parent): return False, f'{stage}: claim superseded by a concurrent P5 writer'
            return True, ''
        def finalize(found, sent_at, how):
            atomic_write(os.path.join(ob, did + '.sent'), json.dumps({'message_id': found, 'at': sent_at, 'how': how, 'epoch': E1}).encode())
            cg = lifecycle_of(read_state(child) or {}).get('status_generation')
            def f(e, lc):
                if e['state'] != 'acked': e['state'] = 'sent'; e['sent_message_id'] = found; e['sent_at'] = sent_at; e['sent_how'] = how; e['child_generation_at_send'] = cg; e['auth_epoch'] = E1
                if replay: e['replayed_at'] = ts()
                early = [x for x in lc['decisions'].get('in_early', []) if x.get('decision_id') == did]
                if early: e['state'] = 'acked'; e['ack_message_id'] = early[0].get('message_id'); lc['decisions']['in_early'] = [x for x in lc['decisions']['in_early'] if x.get('decision_id') != did]
            update_parent(f); record_claim(did, parent, child, E1, phase='finalized')
        # 已有 receipt → 精确回读核验
        rcpt = None; invalid_receipt = None
        if ent['state'] in ('sent', 'delivery_indeterminate') and ent.get('sent_message_id'): rcpt = {'message_id': ent['sent_message_id'], 'at': ent.get('sent_at')}
        elif os.path.exists(os.path.join(ob, did + '.sent')): rcpt = json.load(open(os.path.join(ob, did + '.sent')))
        if rcpt:
            try: m = readback_message(child, rcpt['message_id'], boundary)
            except Exception as e: print(f'receipt readback failed, not sending: {e}'); sys.exit(5)
            if m: scan_text(m, 'receipt')
            ok, why = message_valid(m, did, exec_ou, body, bsha) if m else (False, 'receipt message not found')
            if ok:
                record_claim(did, parent, child, E1)
                if ent['state'] != 'sent' or ent.get('sent_message_id') != rcpt['message_id']: finalize(rcpt['message_id'], msg_time(m).strftime('%Y-%m-%d %H:%M:%S'), 'receipt_recovered')
                else: record_claim(did, parent, child, E1, phase='finalized', reason='already sent')
                print(json.dumps({'decision_id': did, 'message_id': rcpt['message_id'], 'dedup': 'already sent (receipt verified)'})); return 0
            invalid_receipt = {'message_id': rcpt['message_id'], 'why': why, 'at': ts()}
        # 分页查重到时间边界；只有满足 canonical envelope 的历史消息才算命中
        try: msgs = list_messages(child, start=boundary)
        except Exception as e: print(f'dedup query failed, not sending: {e}'); sys.exit(5)
        found = None; found_at = None; how = 'dedup'
        for m in msgs:
            if any(k.get('decision_id') == did for k in find_markers(scan_text(m, 'dedup'))) and message_valid(m, did, exec_ou, body, bsha)[0]: found = m['message_id']; found_at = msg_time(m).strftime('%Y-%m-%d %H:%M:%S'); break
        # All pre-send reads succeeded. Until here, no state/claim/receipt write:
        # an unreadable candidate must leave the same decision retryable.
        record_claim(did, parent, child, E1)
        if invalid_receipt:
            try: os.replace(os.path.join(ob, did + '.sent'), os.path.join(ob, did + f'.sent.invalid.{int(time.time())}'))
            except Exception: pass
            def f(e, lc):
                if e['state'] != 'acked': e['state'] = 'sending'; e['invalid_receipt'] = invalid_receipt; e.pop('sent_message_id', None); e.pop('sent_at', None)
            update_parent(f); print(json.dumps({'receipt_invalidated': rcpt['message_id'], 'why': invalid_receipt['why']}))
        if not found:
            atomic_write(os.path.join(ob, did + '.sending'), json.dumps({'at': ts(), 'epoch': E1}).encode())
            def f(e, lc):
                if e['state'] == 'pending': e['state'] = 'sending'; e['sending_at'] = ts()
            update_parent(f); _hook('P5_TEST_HOOK_PRESEND')
            ok, why = epoch_intact('pre-send')
            if not ok: cancel(why)  # 外写前纪元已变 → 零外发作废
            mid = send_message(child, expected_text(did, exec_ou, body, bsha), as_user=True)
            if not mid: print('send failed'); sys.exit(6)
            _hook('P5_TEST_HOOK_POSTSEND')
            try: m = readback_message(child, mid, boundary)
            except Exception as e: print(f'post-send readback failed (message {mid} unverified, state stays sending): {e}'); sys.exit(6)
            ok, why = message_valid(m, did, exec_ou, body, bsha) if m else (False, 'sent message not found on readback')
            if not ok:
                atomic_write(os.path.join(ob, did + f'.send_unverified.{int(time.time())}'), json.dumps({'message_id': mid, 'why': why, 'at': ts()}).encode())
                update_parent(lambda e, lc: e.setdefault('unverified_sends', []).append({'message_id': mid, 'why': why, 'at': ts()}))
                ledger_line(parent, f'⚠️ 下行决策 {did[:12]} 发送后回读核验失败（{why}），未计 sent，执行者未被真圈，需重发')
                print(json.dumps({'error': 'send unverified: executor not mentioned / content mismatch', 'message_id': mid, 'why': why})); sys.exit(6)
            found, found_at, how = mid, msg_time(m).strftime('%Y-%m-%d %H:%M:%S'), 'sent'
        ok, why = epoch_intact('post-send')
        if not ok:
            # 外写可能已发生而授权纪元漂移 → 不能静默 sent/cancelled：进入 delivery_indeterminate 供 receipt/ack 对账，rc 7
            atomic_write(os.path.join(ob, did + '.indeterminate'), json.dumps({'message_id': found, 'at': ts(), 'why': why, 'epoch_claimed': E1}).encode())
            def f(e, lc):
                if e['state'] != 'acked': e['state'] = 'delivery_indeterminate'; e['sent_message_id'] = found; e['sent_at'] = found_at; e['sent_how'] = how; e['indeterminate_reason'] = why; e['indeterminate_at'] = ts()
            update_parent(f); record_claim(did, parent, child, E1, phase='indeterminate', reason=why)
            ledger_line(parent, f'⚠️ 下行决策 {did[:12]} 发送后授权纪元漂移（{why}）：投递结果不确定，等 receipt/ack 对账，需人工确认')
            print(json.dumps({'error': 'delivery_indeterminate: authorization changed during send', 'message_id': found, 'why': why})); sys.exit(7)
        finalize(found, found_at, how)
    print(json.dumps({'decision_id': did, 'message_id': found, 'replay': replay})); return 0
if op == 'dispatch':
    parent, did = a[1], a[2]; exec_ou = a[3] if len(a) > 3 else None; tf = a[4] if len(a) > 4 else None; sys.exit(do_dispatch(parent, did, exec_ou, tf))
elif op == 'check-unacked':
    # 父侧：sent 超过 2 小时未 ack → 一次去重告警（账本 + 可选本嗓）；terminal 项超过 50 条 → 归档到 transitions-<short>.jsonl
    parent = a[1]; alerts = []; replayed = []; stale_pending = []
    st = read_state(parent)
    if not managed_state(st)[0]: print(json.dumps({'alerted': [], 'replayed': [], 'indeterminate': [], 'note': 'not managed: skipped'})); sys.exit(0)
    lc = lifecycle_of(st)
    for e in list(outbox_entries(lc)):
        if e['state'] in ('pending', 'sending'):
            t0 = e.get('sending_at') or e.get('pending_at')
            age = (now() - datetime.datetime.strptime(t0, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)).total_seconds()
            if age > 600:
                ob = p_outbox(parent)
                if e.get('body_sha') and e.get('exec_ou'):
                    r = subprocess.run([sys.executable, os.path.abspath(__file__), '_replay', parent, e['decision_id']], capture_output=True, text=True, env=os.environ)
                    replayed.append({'decision_id': e['decision_id'], 'rc': r.returncode, 'out': r.stdout.strip()[-200:]})
                else: stale_pending.append(e['decision_id']); replayed.append({'decision_id': e['decision_id'], 'rc': 7, 'out': 'no proposal anchor (legacy no-payload pending): unrecoverable, re-propose'})
    with ChatLock(parent):
        st = read_state(parent); lc = lifecycle_of(st); out = outbox_entries(lc); keep = []
        for e in out:
            if e['state'] == 'delivery_indeterminate' and not e.get('alerted'): e['alerted'] = ts(); alerts.append(e['decision_id'])
            if e['decision_id'] in stale_pending and not e.get('alerted'): e['alerted'] = ts(); alerts.append(e['decision_id'])
            if e['state'] in ('sent', 'sending') and e.get('sent_at') and (now() - datetime.datetime.strptime(e['sent_at'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)).total_seconds() > 7200 and not e.get('alerted'):
                e['alerted'] = ts(); alerts.append(e['decision_id'])
        term = [e for e in out if e['state'] in ('acked', 'cancelled')]
        if len(term) > 50:
            for e in term[:-50]: append_fsync(os.path.join(P5_HOME, f'transitions-{short(parent)}.jsonl'), {'kind': 'decision_archive', 'entry': e, 'at': ts()})
            keepset = {id(e) for e in term[-50:]}; out[:] = [e for e in out if e['state'] not in ('acked', 'cancelled') or id(e) in keepset]
        st['lifecycle'] = lc; write_state(parent, st)
    for d in alerts: ledger_line(parent, f'⚠️ 下行决策 {d[:12]} 超时未闭环（sent>2h 未 ack，或 pending>10min 且无不可变 payload 无法重放——需重新 out-pending 并附 payload）（去重告警一次）')
    for r in replayed: ledger_line(parent, f'下行决策 {r["decision_id"][:12]} pending/sending >10min 已重放 rc={r["rc"]}')
    print(json.dumps({'alerted': alerts, 'replayed': replayed, 'indeterminate': [e['decision_id'] for e in outbox_entries(lifecycle_of(read_state(parent))) if e['state'] == 'delivery_indeterminate']}))
    if any(r['rc'] != 0 for r in replayed) or any(e['state'] == 'delivery_indeterminate' for e in outbox_entries(lifecycle_of(read_state(parent)))): sys.exit(3)  # 重放失败向上传播（r4 P2-2）
elif op == '_replay':
    parent, did = a[1], a[2]; sys.exit(do_dispatch(parent, did, replay=True))
elif op == 'bubble-flush':
    # 子侧：bubbles.out 里 kind=ack 的 pending/sending → 向父群投递 ack marker（receipt 化：outbox/<child>/ack-<did>.sent；查重到 pending_at−10min）
    child = a[1]; st = read_state(child)
    if not managed_state(st)[0]: print(json.dumps({'flushed': [], 'note': 'not managed: skipped'})); sys.exit(0)
    lc = lifecycle_of(st); parent = st.get('parent') or (st.get('parent_chat_id')); done = []
    if not parent: print('no parent'); sys.exit(1)
    ob = p_outbox(child); os.makedirs(ob, exist_ok=True)
    for bcur in [b for b in lc['bubbles'].get('out', []) if b.get('kind') == 'ack' and b.get('state') in ('pending', 'sending')]:
        did = bcur['decision_id']; rc = os.path.join(ob, f'ack-{did}.sent'); found = None
        acquire_lease(ob, f'ack-{did}')  # per-bubble 单发送锁（r4 P2-1）：busy → rc 4 退出，本轮不发
        if os.path.exists(rc): found = json.load(open(rc))['message_id']
        if not found:
            boundary = datetime.datetime.strptime(bcur['pending_at'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ) - datetime.timedelta(minutes=10)
            try: msgs = list_messages(parent, start=boundary)
            except Exception as e: print(f'ack dedup query failed, not sending: {e}'); sys.exit(5)
            for m in msgs:
                if m.get('sender', {}).get('sender_type') == 'app' and m['sender'].get('id') == lark_bot_app() and any(k.get('ack') == did and k.get('child') == short(child) for k in find_markers(scan_text(m, 'ack dedup'))): found = m['message_id']; break
            if not found:
                with ChatLock(child):
                    st = read_state(child); lc = lifecycle_of(st)
                    for b2 in lc['bubbles']['out']:
                        if b2.get('decision_id') == did and b2['state'] == 'pending': b2['state'] = 'sending'; b2['sending_at'] = ts()
                    st['lifecycle'] = lc; write_state(child, st)
                found = send_message(parent, f'{encode_marker({"ack": did, "child": short(child)})} 子群已收到决策 {did[:12]}', as_user=False)
                if not found: print('ack send failed'); sys.exit(6)
            atomic_write(rc, json.dumps({'message_id': found, 'at': ts()}).encode())
        with ChatLock(child):
            st = read_state(child); lc = lifecycle_of(st)
            for b2 in lc['bubbles']['out']:
                if b2.get('decision_id') == did and b2['state'] in ('pending', 'sending'): b2['state'] = 'sent'; b2['sent_message_id'] = found; b2['sent_at'] = ts()
            st['lifecycle'] = lc; write_state(child, st)
        done.append({'decision_id': did, 'message_id': found})
    task_done = []
    # The task-event implementation is not yet accepted. Do not activate it
    # for resident observers or unrelated nodes while this work is in review.
    if os.environ.get('P5_DELEGATION_TRIAL_ROOT') and os.environ.get('P5_DELEGATION_TRIAL_ROOT') == delegation_identity()[0] and (read_state(child).get('delegation') or {}).get('root_request_id') == os.environ['P5_DELEGATION_TRIAL_ROOT']:
        er = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'p5-task-event.py'), 'flush', child], capture_output=True, text=True, env=os.environ)
        if er.returncode != 0:
            print(json.dumps({'flushed': done, 'task_event_error': er.stdout.strip()[-500:]}, ensure_ascii=False)); sys.exit(6)
        task_done = json.loads(er.stdout).get('flushed', [])
    print(json.dumps({'flushed': done, 'task_events': task_done}, ensure_ascii=False))
elif op == 'ack-scan':
    parent = a[1]; st = read_state(parent)
    if not managed_state(st)[0]: print(json.dumps({'acked': {}, 'rejected': [], 'note': 'not managed: skipped'})); sys.exit(0)
    lc = lifecycle_of(st); open_ids = {e['decision_id'] for e in outbox_entries(lc) if e['state'] in ('sent', 'delivery_indeterminate')}; hits = {}
    if open_ids:
        oldest = min(datetime.datetime.strptime(e.get('sent_at') or e['pending_at'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ) for e in outbox_entries(lc) if e['state'] in ('sent', 'delivery_indeterminate'))
        msgs = list_messages(parent, start=oldest - datetime.timedelta(minutes=10)); ents = {e['decision_id']: e for e in outbox_entries(lc) if e['state'] in ('sent', 'delivery_indeterminate')}
        rejected = []
        for m in msgs:
            for k in find_markers(scan_text(m, 'ack scan')):
                did = k.get('ack')
                if did not in open_ids or did in hits: continue
                e = ents[did]; s = m.get('sender', {}); sent_at = datetime.datetime.strptime(e['sent_at'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)
                why = None
                if s.get('sender_type') != 'app' or s.get('id') != lark_bot_app(): why = 'sender not the bot app'
                elif k.get('child') != short(e['to']): why = 'child mismatch'
                elif msg_time(m) < sent_at - datetime.timedelta(seconds=60): why = 'ack earlier than sent_at'
                if why: rejected.append({'decision_id': did[:12], 'message_id': m['message_id'], 'why': why}); continue
                hits[did] = m['message_id']
        with ChatLock(parent):
            st = read_state(parent); lc = lifecycle_of(st)
            for e in outbox_entries(lc):
                if e['decision_id'] in hits and e['state'] in ('sent', 'delivery_indeterminate'):
                    if e['state'] == 'delivery_indeterminate': e['indeterminate_resolved_by_ack'] = True
                    e['state'] = 'acked'; e['ack_message_id'] = hits[e['decision_id']]; e['acked_at'] = ts()
            st['lifecycle'] = lc; write_state(parent, st)
    print(json.dumps({'acked': hits, 'rejected': rejected if open_ids else []}))
elif op == 'in-scan':
    # 子侧：本群里 owner 身份发的 [p5:{decision_id}] marker → 必须能在父 state 的 outbox 里找到 to==本群 且 sent_message_id==本消息 的条目（父的 receipt 绑定），才登记 + 建 ack bubble。
    # 结构合法但父 receipt 尚未可见（父在 .sent→state 之间崩溃）→ 进 decisions.in_unresolved，watermark 绝不越过最早 unresolved；每轮先按父 outbox 复核 unresolved。
    child = a[1]; st = read_state(child); parent = (st or {}).get('parent'); recorded = []; rejected = []
    if not managed_state(st)[0]: print(json.dumps({'recorded': [], 'note': f'not managed ({managed_state(st)[1]}): in-scan skipped (no writes)'})); sys.exit(0)
    lc = lifecycle_of(st)
    if not parent: print(json.dumps({'recorded': [], 'note': 'no parent'})); sys.exit(0)
    pst = read_state(parent)
    if pst is None: print('parent state unreadable'); sys.exit(1)
    pout = {e['decision_id']: e for e in lifecycle_of(pst)['decisions'].get('out', [])}
    owner_ids = {o.get('owner_open_id') for o in cfg().get('owners', []) if o.get('owner_open_id')}; mention_cache = {}
    def record(did, mid):
        with ChatLock(child):
            st2 = read_state(child); lc2 = lifecycle_of(st2)
            if not any(x.get('decision_id') == did for x in lc2['decisions'].get('in', [])):
                lc2['decisions'].setdefault('in', []).append({'decision_id': did, 'message_id': mid, 'received_at': ts()})
                lc2['bubbles'].setdefault('out', []).append({'kind': 'ack', 'decision_id': did, 'state': 'pending', 'pending_at': ts()})
            lc2['decisions']['in_unresolved'] = [u for u in lc2['decisions'].get('in_unresolved', []) if u.get('decision_id') != did]
            st2['lifecycle'] = lc2; write_state(child, st2); recorded.append(did)
    def classify(did, mid, sender):
        """→ ('ok'|'unresolved'|'reject', why)"""
        e = pout.get(did)
        if sender.get('sender_type') != 'user' or sender.get('id') not in owner_ids: return 'reject', 'sender not owner identity'
        if not e: return 'reject', 'unknown decision in parent outbox'
        if e.get('to') != child: return 'reject', 'decision not addressed to this chat'
        if e.get('exec_ou') and mid in mention_cache and e['exec_ou'] not in mention_cache[mid]: return 'reject', 'executor not mentioned in this message'
        if e.get('sent_message_id') == mid: return 'ok', ''
        if e.get('sent_message_id') is None and e.get('state') in ('pending', 'sending'): return 'unresolved', 'parent receipt not yet visible'
        if e.get('state') == 'cancelled': return 'reject', 'decision cancelled'
        return 'reject', 'message_id != parent receipt'
    # ① 复核 unresolved（不读消息）
    unresolved = list(lc['decisions'].get('in_unresolved', []))
    for u in unresolved:
        if any(x.get('decision_id') == u['decision_id'] for x in lc['decisions'].get('in', [])): u['drop'] = 'already recorded'; continue
        if 'mentions' in u: mention_cache[u['message_id']] = set(u['mentions'])
        c, why = classify(u['decision_id'], u['message_id'], u['sender'])
        if c == 'ok': record(u['decision_id'], u['message_id'])
        elif c == 'reject': u['drop'] = why; rejected.append({'decision_id': u['decision_id'][:12], 'message_id': u['message_id'], 'why': why + ' (unresolved dropped)'})
    still = [u for u in unresolved if not u.get('drop') and u['decision_id'] not in recorded]
    # ② 扫描：起点 = min(watermark, 最早 unresolved) − 10min
    wm = (lc['decisions'].get('in_watermark') or tstr_of(now() - datetime.timedelta(hours=48)))
    since_t = datetime.datetime.strptime(wm, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)
    for u in still: since_t = min(since_t, datetime.datetime.strptime(u['at'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ))
    msgs = list_messages(child, start=since_t - datetime.timedelta(minutes=10)); newest = None
    for m in sorted(msgs, key=msg_time):
        newest = msg_time(m); mention_cache[m['message_id']] = {x.get('id') for x in (m.get('mentions') or []) if isinstance(x, dict)}
        for k in find_markers(scan_text(m, 'decision in-scan')):
            did = k.get('decision_id')
            if not did: continue
            if any(x.get('decision_id') == did for x in lifecycle_of(read_state(child))['decisions'].get('in', [])): continue
            c, why = classify(did, m['message_id'], m.get('sender', {}))
            if c == 'ok': record(did, m['message_id'])
            elif c == 'unresolved':
                if not any(u['decision_id'] == did and u['message_id'] == m['message_id'] for u in still): still.append({'decision_id': did, 'message_id': m['message_id'], 'at': msg_time(m).strftime('%Y-%m-%d %H:%M:%S'), 'sender': m.get('sender', {}), 'mentions': sorted(mention_cache[m['message_id']]), 'why': why})
            else: rejected.append({'decision_id': did[:12], 'message_id': m['message_id'], 'why': why})
    # ③ 水位：不越过最早 unresolved
    new_wm = newest
    for u in still:
        ut = datetime.datetime.strptime(u['at'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)
        new_wm = ut if new_wm is None else min(new_wm, ut)
    with ChatLock(child):
        st2 = read_state(child); lc2 = lifecycle_of(st2); lc2['decisions']['in_unresolved'] = still
        if new_wm: lc2['decisions']['in_watermark'] = new_wm.strftime('%Y-%m-%d %H:%M:%S')
        st2['lifecycle'] = lc2; write_state(child, st2)
    print(json.dumps({'recorded': recorded, 'rejected': rejected, 'unresolved': [u['decision_id'][:12] for u in still], 'watermark': new_wm.strftime('%Y-%m-%d %H:%M:%S') if new_wm else None}))
elif op == 'roundend-outbox':
    chat = a[1]; st = read_state(chat); steps = []
    if not managed_state(st)[0]: print(json.dumps({'steps': [], 'failed': None, 'note': f'not managed ({managed_state(st)[1]}): outbox maintenance skipped (no writes)'})); sys.exit(0)
    lc = lifecycle_of(st)
    def step(name, args):
        r = subprocess.run([sys.executable, os.path.abspath(__file__)] + args, capture_output=True, text=True, env=os.environ)
        steps.append({'step': name, 'rc': r.returncode, 'out': r.stdout.strip()[-300:]})
        if r.returncode != 0: print(json.dumps({'steps': steps, 'failed': name}, ensure_ascii=False)); sys.exit(5)
    trial=os.environ.get('P5_DELEGATION_TRIAL_ROOT') and os.environ.get('P5_DELEGATION_TRIAL_ROOT') == delegation_identity()[0] and (st.get('delegation') or {}).get('root_request_id') == os.environ.get('P5_DELEGATION_TRIAL_ROOT')
    if trial:
        for command in ('ingest','flush'):
            r=subprocess.run([sys.executable,os.path.join(os.path.dirname(os.path.abspath(__file__)),'p5-task-control.py'),command,chat],capture_output=True,text=True,env=os.environ)
            steps.append({'step':'task-control-'+command,'rc':r.returncode,'out':r.stdout.strip()[-300:]})
            if r.returncode: print(json.dumps({'steps':steps,'failed':'task-control-'+command},ensure_ascii=False)); sys.exit(5)
    if st.get('parent'):
        step('in-scan', ['in-scan', chat])
    if st.get('children') and os.environ.get('P5_DELEGATION_TRIAL_ROOT') and os.environ.get('P5_DELEGATION_TRIAL_ROOT') == delegation_identity()[0] and (st.get('delegation') or {}).get('root_request_id') == os.environ['P5_DELEGATION_TRIAL_ROOT']:
        r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'p5-task-event.py'), 'ingest', chat], capture_output=True, text=True, env=os.environ)
        steps.append({'step': 'task-event-ingest', 'rc': r.returncode, 'out': r.stdout.strip()[-300:]})
        if r.returncode != 0: print(json.dumps({'steps': steps, 'failed': 'task-event-ingest'}, ensure_ascii=False)); sys.exit(5)
    if st.get('parent') and any(b.get('kind') in ('ack', 'task_event') and b.get('state') in ('pending', 'sending') for b in lifecycle_of(read_state(chat))['bubbles'].get('out', [])):
        step('bubble-flush', ['bubble-flush', chat])
    out = lifecycle_of(read_state(chat))['decisions'].get('out', [])
    if out: step('check-unacked', ['check-unacked', chat])  # 先重放/告警，再扫 ack（重放命中的条目同轮即可 acked）
    out = lifecycle_of(read_state(chat))['decisions'].get('out', [])
    if any(e['state'] == 'sent' for e in out): step('ack-scan', ['ack-scan', chat])
    print(json.dumps({'steps': steps, 'failed': None}, ensure_ascii=False))
elif op == 'in-record':
    child, did, mid = a[1], a[2], a[3]
    with ChatLock(child):
        st = read_state(child); mok, mwhy = managed_state(st)
        if not mok: print(json.dumps({'recorded': None, 'error': f'not managed ({mwhy}): in-record refused, no writes'})); sys.exit(9)  # r12 P1-1：正式 CLI 同一 managed 硬门
        lc = lifecycle_of(st)
        if any(x.get('decision_id') == did for x in lc['decisions'].get('in', [])): print('dup'); sys.exit(0)
        lc['decisions'].setdefault('in', []).append({'decision_id': did, 'message_id': mid, 'received_at': ts()})
        lc['bubbles'].setdefault('out', []).append({'kind': 'ack', 'decision_id': did, 'state': 'pending', 'pending_at': ts()})
        st['lifecycle'] = lc; write_state(child, st)
    print('recorded')
elif op == 'ack':
    parent, did, mid = a[1], a[2], a[3]
    with ChatLock(parent):
        st = read_state(parent); mok, mwhy = managed_state(st)
        if not mok: print(json.dumps({'acked': None, 'error': f'not managed ({mwhy}): ack refused, no writes'})); sys.exit(9)  # r12 P1-1
        lc = lifecycle_of(st); hit = False
        for e in outbox_entries(lc):
            if e['decision_id'] == did and e['state'] == 'sent': e['state'] = 'acked'; e['ack_message_id'] = mid; e['acked_at'] = ts(); hit = True
        if not hit: lc['decisions'].setdefault('in_early', []).append({'decision_id': did, 'message_id': mid, 'at': ts()})
        st['lifecycle'] = lc; write_state(parent, st)
    print('acked' if hit else 'early')
