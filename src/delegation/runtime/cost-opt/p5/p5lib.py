#!/usr/bin/env python3
"""P5 · 群状态机驱动的观测节流 —— 共享库（实现基线：P5-design-v7.md sha 7ec9faca）。
所有路径/外部命令都可用环境变量重定向，便于 selftest 沙箱：
  P5_HOME (默认 ~/.botmux/delegation)  BOTMUX_HOME (默认 ~/.botmux)  P5_CONFIG (默认 $P5_HOME/cost-opt/p5/p5-config.json)
  P5_BOTMUX_BIN / P5_LARK_BIN (默认 botmux / lark-cli)  P5_PROC_FIXTURE (测试：进程/tmux/CLI 日志的 JSON 快照)  P5_NOW (测试：固定时间)
"""
import fcntl, os, sys, json, hashlib, time, datetime, subprocess, fcntl, base64, re, glob, uuid, shutil

# ---------- 环境 ----------
P5_HOME = os.path.expanduser(os.environ.get('P5_HOME', '~/.botmux/delegation'))
BOTMUX_HOME = os.path.expanduser(os.environ.get('BOTMUX_HOME', '~/.botmux'))
CONFIG_PATH = os.path.expanduser(os.environ.get('P5_CONFIG', os.path.join(P5_HOME, 'cost-opt/p5/p5-config.json')))
BOTMUX_BIN = os.environ.get('P5_BOTMUX_BIN', 'botmux')
LARK_BIN = os.environ.get('P5_LARK_BIN', 'lark-cli')
BJ = datetime.timezone(datetime.timedelta(hours=8))
MIN_QUIET_SEC = 30 * 60
MIN_DWELL_SEC = 30 * 60
HEARTBEAT_MAX_AGE = 25 * 60
CHILD_STALE_SEC = 90 * 60
MAX_ASKS = 3

def now():
    v = os.environ.get('P5_NOW')
    if v: return datetime.datetime.fromisoformat(v).astimezone(BJ)
    return datetime.datetime.now(BJ)
def ts(): return now().strftime('%Y-%m-%d %H:%M:%S')
def short(chat): return chat[:11]
def sha256b(b): return hashlib.sha256(b).hexdigest()
def canonical(obj): return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
def csha(obj): return sha256b(canonical(obj).encode())
def load_config():
    if not os.path.exists(CONFIG_PATH): raise RuntimeError(f'config missing: {CONFIG_PATH}')
    return json.load(open(CONFIG_PATH))
def delegation_scope(section, config=None):
    """Read the existing single-task configuration; never supply identity defaults."""
    config = load_config() if config is None else config
    value = config.get(section)
    if not isinstance(value, dict): raise RuntimeError(f'config missing: {section}')
    for field in ('root_request_id', 'task_id'):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise RuntimeError(f'config missing or invalid: {section}.{field}')
    path = value.get('allowed_path')
    if not isinstance(path, list) or not path or any(not isinstance(ch, str) or not ch.startswith('oc_') for ch in path) or len(set(path)) != len(path):
        raise RuntimeError(f'config missing or invalid: {section}.allowed_path')
    if type(value.get('enabled')) is not bool:
        raise RuntimeError(f'config missing or invalid: {section}.enabled')
    return value
def delegation_identity():
    """Shared event/control identity from the configured version or auto scope."""
    config = load_config()
    scopes = [delegation_scope(k, config) for k in ('version_migration', 'delegation_auto') if k in config]
    if not scopes: raise RuntimeError('config missing: version_migration or delegation_auto')
    identities = {(s['root_request_id'], s['task_id']) for s in scopes}
    if len(identities) != 1: raise RuntimeError('config task identity differs between version_migration and delegation_auto')
    return next(iter(identities))
def configured_delegation_chat(chat):
    root = ((read_state(chat) or {}).get('delegation') or {}).get('root_request_id')
    return bool(root) and root == delegation_identity()[0]
CFG = None
def cfg():
    global CFG
    if CFG is None: CFG = load_config()
    return CFG
def owner_id_for_app(app):
    for o in cfg().get('owners', []):
        if o.get('lark_app_id') == app and o.get('owner_open_id') and o.get('verified_at'): return o['owner_open_id']
    return None
def observer_app(): return cfg()['observer_app']
def transport_readers():
    readers = cfg().get('transport', {}).get('readers')
    if not isinstance(readers, list) or not readers:
        raise RuntimeError('config missing: transport.readers')
    for reader in readers:
        if not all(reader.get(k) for k in ('profile', 'app_id')) or reader.get('as') not in ('user', 'bot'):
            raise RuntimeError('config invalid: transport.readers requires profile, app_id, as')
    return readers
def transport_sender_profile():
    profile = cfg().get('transport', {}).get('sender_profile')
    if not isinstance(profile, str) or not profile:
        raise RuntimeError('config missing: transport.sender_profile')
    return profile
def executor_apps(): return set(cfg().get('executor_apps', []))
def noise_apps(): return set(cfg().get('noise_apps', []))
def role_apps_for(chat_or_state):
    """Resolve role apps from the registered node type; global map is legacy fallback."""
    st = chat_or_state if isinstance(chat_or_state, dict) else (read_state(chat_or_state) if chat_or_state else None)
    tp = (st or {}).get('type')
    by_type = cfg().get('role_apps_by_type') or {}
    if tp in by_type:
        return dict(by_type[tp])
    return dict(cfg().get('role_apps') or {})

# ---------- 路径 ----------
def p_state(chat): return os.path.join(P5_HOME, 'webroot', f'state-{short(chat)}.json')
def p_taskbook(chat): return os.path.join(P5_HOME, f'taskbook-{short(chat)}.md')
def p_tbindex(): return os.path.join(P5_HOME, 'taskbook-index.jsonl')
def p_plans(chat): return os.path.join(P5_HOME, 'plans', short(chat))
def p_journal(chat): return os.path.join(P5_HOME, 'journal', f'{short(chat)}.jsonl')
def p_repairs(chat): return os.path.join(P5_HOME, 'repairs', f'{short(chat)}.jsonl')
def p_lock(chat): return os.path.join(P5_HOME, 'locks', f'{short(chat)}.lock')
def p_outbox(chat): return os.path.join(P5_HOME, 'outbox', short(chat))
def p_heartbeat(): return os.path.join(P5_HOME, 'health', 'p5-repair.heartbeat')
def p_ledger(chat): return os.path.join(P5_HOME, f'ledger-{short(chat)}.md')
def p_schedules(): return os.path.join(BOTMUX_HOME, 'bots', observer_app(), 'schedules.json')
def p_policies(): return os.path.join(BOTMUX_HOME, 'data', 'chat-policies.json')
def ensure_dirs(chat=None):
    for d in ('plans', 'journal', 'repairs', 'locks', 'outbox', 'health', 'webroot'):
        os.makedirs(os.path.join(P5_HOME, d), exist_ok=True)
    if chat: os.makedirs(p_plans(chat), exist_ok=True); os.makedirs(p_outbox(chat), exist_ok=True)

# ---------- 原子写 / 追加 / 锁 ----------
def atomic_write(path, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp.%d' % os.getpid()
    with open(tmp, 'wb') as f:
        f.write(data); f.flush(); os.fsync(f.fileno())
    os.rename(tmp, path)
    try:
        dfd = os.open(os.path.dirname(path), os.O_RDONLY); os.fsync(dfd); os.close(dfd)
    except Exception: pass
def append_fsync(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as f:
        f.write(canonical(obj) + '\n'); f.flush(); os.fsync(f.fileno())
def read_jsonl(path):
    if not os.path.exists(path): return []
    out = []
    for l in open(path, encoding='utf-8'):
        l = l.strip()
        if l: out.append(json.loads(l))
    return out
class ChatLock:
    def __init__(self, chat, blocking=True):
        ensure_dirs(chat); self.path = p_lock(chat); self.blocking = blocking; self.fd = None
    def __enter__(self):
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        try: fcntl.flock(self.fd, fcntl.LOCK_EX | (0 if self.blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            os.close(self.fd); self.fd = None; raise RuntimeError('lock busy: ' + self.path)
        return self
    def __exit__(self, *a):
        if self.fd is not None: fcntl.flock(self.fd, fcntl.LOCK_UN); os.close(self.fd); self.fd = None

# ---------- state / lifecycle ----------
DEFAULT_LIFECYCLE = {'status': 'active', 'status_generation': 0, 'status_changed_at': None, 'wake_checked_at': None,
                     'status_reason': None, 'finish_pending': None, 'reopen_pending': None, 'provenance': None,
                     'candidate_since': None, 'finished_evidence': None,
                     'wake': {'cron': None, 'instant': None}, 'wake_backup': {'cron': None, 'instant': None},
                     'children_seen': {}, 'decisions': {'out': [], 'in': [], 'in_early': []}, 'bubbles': {'out': []}}
BOOKKEEPING_ALLOW = ('wake_checked_at', 'finish_pending.asks', 'reopen_pending', 'children_seen', 'decisions', 'bubbles')
def read_state(chat):
    p = p_state(chat)
    if not os.path.exists(p): return None
    return json.load(open(p, encoding='utf-8'))
def lifecycle_of(state):
    lc = json.loads(json.dumps(DEFAULT_LIFECYCLE))
    if state and isinstance(state.get('lifecycle'), dict):
        for k, v in state['lifecycle'].items(): lc[k] = v
    return lc
def lifecycle_sha(lc): return csha(lc)
def auth_projection(state):
    """授权相关投影：拓扑 / 执行者登记 / 生命周期状态与代数。任何写者改动它 → 该 chat 上的在途 dispatch claim 被 supersede。"""
    st = state or {}; lc = st.get('lifecycle') if isinstance(st.get('lifecycle'), dict) else {}
    d=st.get('delegation') or {}
    return {'parent': st.get('parent'), 'children': sorted(st.get('children') or []), 'executor_ou': st.get('executor_ou'), 'type': st.get('type'), 'status': lc.get('status'), 'gen': lc.get('status_generation'),
            'delegation_root':d.get('root_request_id'),'task_bindings':d.get('bindings',{}),'task_controls':d.get('controls',{}),
            'task_branch_controls':d.get('branch_controls',{}),'task_versions':d.get('task_versions',{})}

def task_binding(st, task, version=None):
    """Resolve a version without replacing the original immutable binding."""
    d=(st or {}).get('delegation') or {}; versions=(d.get('task_versions') or {}).get(task) or {}
    if version is None: version=versions.get('active_version')
    if version is not None:
        entry=(versions.get('versions') or {}).get(str(version))
        if entry: return entry.get('binding')
    old=(d.get('bindings') or {}).get(task)
    return old if old and (version is None or old.get('task_version')==version) else None

def version_contract_text(binding):
    p=(binding or {}).get('version_plan')
    if not p: return []
    return ['migration_id='+binding['migration_id']]+['document_sha256='+d['sha256'] for d in p['documents']]

def p_approval_renewal(rid):
    if not re.fullmatch(r'[a-f0-9]{64}',str(rid)): raise RuntimeError('invalid renewal receipt id')
    return os.path.join(P5_HOME,'approval-renewals',rid+'.json')

def validate_approval_renewals(binding):
    """A changed expiry needs a committed, consecutive independent approval trail.

    The migration identity remains the hash of the ORIGINAL full plan. This
    reader gate also prevents a partially published batch from granting time.
    """
    history=binding.get('approval_renewals') or []
    if not history: raise RuntimeError('renewed plan has no approval trail')
    p=json.loads(json.dumps(binding['version_plan'])); p['expires_at']=history[0]['old_expires_at']
    mid=binding.get('migration_id')
    if csha(p)!=mid: raise RuntimeError('renewal changed original migration identity/content')
    expiry=p['expires_at']; previous=None
    for n,a in enumerate(history,1):
        if type(a.get('renewal_version')) is not int or a['renewal_version']!=n or a.get('migration_id')!=mid or a.get('old_expires_at')!=expiry or a.get('previous_renewal_id')!=previous:
            raise RuntimeError('renewal sequence/identity mismatch')
        proof=json.load(open(p_approval_renewal(a['renewal_id']),encoding='utf-8'))
        if proof.get('phase')!='committed' or proof.get('audit')!=a:
            raise RuntimeError('renewal batch not committed or receipt differs')
        auth=a.get('authorization') or {}
        if not auth.get('reviewer_app') or auth.get('reviewer_app')==auth.get('executor_app') or not auth.get('proposal_message_id') or not auth.get('review_message_id'):
            raise RuntimeError('renewal lacks independent specific approval')
        if a['new_expires_at']<=expiry: raise RuntimeError('renewal window not strictly increasing')
        expiry=a['new_expires_at']; previous=a['renewal_id']
    if binding['version_plan']['expires_at']!=expiry: raise RuntimeError('effective expiry differs from last committed renewal')
    return mid

def registered_descendant(chat, root):
    """Exact registered ancestry, never a name prefix or a subtree-wide scan."""
    seen=set()
    while chat:
        if chat in seen: return False
        seen.add(chat); st=read_state(chat)
        if not st or st.get('chat_id')!=chat: return False
        if chat==root: return True
        parent=st.get('parent')
        if parent and chat not in ((read_state(parent) or {}).get('children') or []): return False
        chat=parent
    return False

def branch_control_key(task, target): return csha([task,target])
def task_control_for(st, task, origin):
    d=(st or {}).get('delegation') or {}
    direct=(d.get('controls') or {}).get(task)
    candidates=[direct] if direct else []
    for c in (d.get('branch_controls') or {}).values():
        if (c.get('scope')=='child' and c.get('task_id')==task
                and c.get('root_request_id')==d.get('root_request_id')
                and registered_descendant(origin,c.get('target_child'))):
            candidates.append(c)
    # A released broader control must not hide an outstanding narrower pause.
    return next((c for c in candidates if c.get('state')=='paused'),candidates[0] if candidates else {})

def task_chain_guard(parent, child, task, chain):
    """Only an enrolled task uses the trial path; a pause is not idle throttling.

    Inspect the registered ancestor chain as well: a disconnected intermediate
    must not issue a fresh assignment while a persisted upstream pause awaits
    delivery. This reads only the exact branch, never a fleet-wide scan.
    """
    pst=read_state(parent) or {}; d=pst.get('delegation') or {}
    if not d.get('root_request_id'):
        return 'chain requires explicit task enrollment' if chain else None
    if not chain: return 'enrolled task must use the single chain dispatch path'
    if chain.get('root_request_id')!=d.get('root_request_id') or chain.get('task_id')!=task:
        return 'root/task differs from enrolled chain'
    bind=task_binding(pst,task)
    if not bind: return 'parent has no verified task delivery binding'
    if bind.get('task_version')!=chain.get('task_version'): return 'task version differs from bound delivery'
    if bind.get('delivery_message_id')!=chain.get('parent_delivery_id'): return 'upstream delivery differs from bound receipt'
    expired_approval=False
    if bind.get('migration_id'):
        if bind.get('approval_renewals'):
            try: validate_approval_renewals(bind)
            except Exception as e: return 'invalid approval renewal: '+str(e)
        if bind.get('acceptance_status')!='accepted': return 'new version requires new real acceptance before dispatch'
        path=bind['version_plan']['path']
        vg=load_config().get('version_migration') or {}
        if vg.get('enabled') is not True or vg.get('root_request_id')!=chain['root_request_id'] or vg.get('task_id')!=task or vg.get('allowed_path')!=path:
            return 'version migration disabled or outside enabled scope'
        try: expiry=datetime.datetime.strptime(bind['version_plan']['expires_at'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)
        except (KeyError,TypeError,ValueError): return 'invalid version approval expiry'
        # Report every non-expiry prohibition first. The explicit renewal entry
        # may repair ONLY this last error; it never suppresses another guard.
        expired_approval=now()>=expiry
        if parent not in path or (child and (path.index(parent)+1>=len(path) or path[path.index(parent)+1]!=child)):
            return 'dispatch outside explicitly versioned path'
        if not child: return 'version migration authorizes existing edges, not new groups'
    seen=set(); cursor=parent
    while cursor:
        if cursor in seen: return 'cycle in registered ancestor chain'
        seen.add(cursor); st=read_state(cursor)
        if not st or st.get('chat_id')!=cursor: return 'ancestor state missing or short-id collision'
        dg=st.get('delegation') or {}
        if dg.get('root_request_id')==chain['root_request_id']:
            ab=task_binding(st,task)
            if ab and ab.get('task_version',0)>chain['task_version']: return 'obsolete task version at '+cursor
            if bind.get('migration_id') and (not ab or ab.get('migration_id')!=bind['migration_id'] or ab.get('acceptance_status')!='accepted'):
                return 'ancestor missing accepted version binding at '+cursor
            ctrl=task_control_for(st,task,child or parent)
            if ctrl.get('state')=='paused': return 'task paused at '+cursor
            if ctrl.get('state')=='released' and chain['task_version']<ctrl.get('resume_task_version',0): return 'released task requires a new version at '+cursor
            if int(ctrl.get('task_version') or 0)>chain['task_version']: return 'obsolete task version at '+cursor
        up=st.get('parent')
        if up and cursor not in ((read_state(up) or {}).get('children') or []): return 'unregistered ancestor edge'
        cursor=up
    if child:
        cs=read_state(child) or {}; cd=cs.get('delegation') or {}; ctrl=(cd.get('controls') or {}).get(task) or {}
        if cd.get('root_request_id') and cd['root_request_id']!=chain['root_request_id']: return 'child belongs to a different task trial'
        if ctrl.get('state')=='paused': return 'child task paused'
        if ctrl.get('state')=='released' and chain['task_version']<ctrl.get('resume_task_version',0): return 'released child requires a new version'
    if expired_approval: return 'version approval expired; retain history, do not dispatch'
    return None
MANAGED_SOURCES = ('bootstrap', 'backfill', 'migrate')
STATUS_ENUM = ('active', 'paused', 'finished', 'unmanaged')
def _is_int(v): return isinstance(v, int) and not isinstance(v, bool)
def _ts_ok(v):
    if v is None: return True
    if not isinstance(v, str): return False
    try: datetime.datetime.strptime(v, '%Y-%m-%d %H:%M:%S'); return True
    except Exception: return False
def _cron_ok(v):
    return v is None or (isinstance(v, dict) and all(isinstance(v.get(k), str) and v.get(k) for k in ('name', 'schedule', 'prompt')))
def executor_app(chat_or_state=None):
    """当前登记的执行者 app（reopen ask 唯一允许的发起方）：config.role_apps.executor，缺省 executor_apps[0]。"""
    c = cfg(); return role_apps_for(chat_or_state).get('executor') or (c.get('executor_apps') or [None])[0]
def ask_app_for(kind, chat_or_state=None):
    """r13 P1-1 角色 scope：finish ask 只允许 observer_app 发起，reopen ask 只允许当前登记执行者 app 发起。"""
    return observer_app() if kind == 'finish' else executor_app(chat_or_state)
def known_apps():
    c = cfg(); return {o.get('lark_app_id') for o in c.get('owners', []) if o.get('lark_app_id')} | {c.get('observer_app')} | set(c.get('executor_apps', []))
def verified_owner_ids():
    return {o['owner_open_id'] for o in cfg().get('owners', []) if o.get('owner_open_id') and o.get('verified_at')}
def pending_schema_errors(kind, v, chat_or_state=None):
    """r12 P1-2：finish_pending / reopen_pending 按 p5-ask 与 valid_receipt 的实际契约递归校验。返回错误列表。
    finish: {proposal_id: str, generation_after: int>=0, [proposed_at: ts], [proposal_message_id: str|None], asks: [ask]}
    reopen: {proposal_id: str, generation: int>=0, asks: [ask]}
    ask: {attempt: int>=1 且恰为 1..n 递增, started_at: ts, ask_lark_app_id: 配置内已知 app, receipt: None | {at: ts, [rc: int], [timedOut: bool], [selected: None|str], [by: None|str]}}；len(asks) <= MAX_ASKS"""
    if v is None: return []
    p = f'{kind}_pending'
    if not isinstance(v, dict): return [f'{p} not None/dict']
    errs = []
    if not isinstance(v.get('proposal_id'), str) or not v['proposal_id']: errs.append(f'{p}.proposal_id not non-empty str')
    gk = 'generation_after' if kind == 'finish' else 'generation'
    if not _is_int(v.get(gk)) or v.get(gk) < 0: errs.append(f'{p}.{gk} not non-negative int')
    if kind == 'finish':
        if 'proposed_at' in v and not (isinstance(v['proposed_at'], str) and _ts_ok(v['proposed_at'])): errs.append(f'{p}.proposed_at not timestamp')
        if 'proposal_message_id' in v and v['proposal_message_id'] is not None and not isinstance(v['proposal_message_id'], str): errs.append(f'{p}.proposal_message_id not None/str')
    asks = v.get('asks')
    if not isinstance(asks, list): return errs + [f'{p}.asks not list']
    if len(asks) > MAX_ASKS: errs.append(f'{p}.asks longer than MAX_ASKS')
    apps = known_apps()
    for i, a in enumerate(asks):
        if not isinstance(a, dict): errs.append(f'{p}.asks[{i}] not dict'); continue
        if not _is_int(a.get('attempt')) or a.get('attempt') != i + 1: errs.append(f'{p}.asks[{i}].attempt must be int {i + 1} (got {a.get("attempt")!r})')
        if not (isinstance(a.get('started_at'), str) and _ts_ok(a['started_at'])): errs.append(f'{p}.asks[{i}].started_at not timestamp')
        if a.get('ask_lark_app_id') not in apps: errs.append(f'{p}.asks[{i}].ask_lark_app_id not a configured app')
        elif a.get('ask_lark_app_id') != ask_app_for(kind, chat_or_state): errs.append(f'{p}.asks[{i}].ask_lark_app_id {a.get("ask_lark_app_id")!r} not the {kind} scope app {ask_app_for(kind, chat_or_state)!r}')
        r = a.get('receipt')
        if r is not None:
            if not isinstance(r, dict) or not (isinstance(r.get('at'), str) and _ts_ok(r['at'])): errs.append(f'{p}.asks[{i}].receipt not None/dict with timestamp at'); continue
            if 'rc' in r and not _is_int(r['rc']): errs.append(f'{p}.asks[{i}].receipt.rc not int')
            if 'timedOut' in r and not isinstance(r['timedOut'], bool): errs.append(f'{p}.asks[{i}].receipt.timedOut not bool')
            for k in ('selected', 'by'):
                if k in r and r[k] is not None and not isinstance(r[k], str): errs.append(f'{p}.asks[{i}].receipt.{k} not None/str')
    return errs
def lifecycle_schema_errors(st):
    """r11 P1-2 深校验：lifecycle 每个键的类型/枚举/嵌套形态 + 顶层 paused 与 status 一致。返回错误列表（[] = 结构完整）。
    任一错误 → 非 managed：不出 plan、不建/不续 repair、零外写；类型损坏绝不能先 remove cron / 关 instant。"""
    lc = st.get('lifecycle')
    if not isinstance(lc, dict): return ['lifecycle not a dict']
    missing = [k for k in DEFAULT_LIFECYCLE if k not in lc]
    if missing: return [f'missing {k}' for k in missing]
    errs = []
    if lc['status'] not in STATUS_ENUM: errs.append(f'status {lc["status"]!r} not in {STATUS_ENUM}')
    g = lc['status_generation']
    if not _is_int(g) or g < 0: errs.append(f'status_generation {g!r} not a non-negative int')
    for k in ('status_changed_at', 'wake_checked_at', 'candidate_since'):
        if not _ts_ok(lc[k]): errs.append(f'{k} {lc[k]!r} not None/"YYYY-MM-DD HH:MM:SS"')
    if lc['status_reason'] is not None and not isinstance(lc['status_reason'], str): errs.append('status_reason not None/str')
    errs += pending_schema_errors('finish', lc['finish_pending'], st) + pending_schema_errors('reopen', lc['reopen_pending'], st)
    for k in ('provenance', 'finished_evidence'):
        if lc[k] is not None and not isinstance(lc[k], dict): errs.append(f'{k} not None/dict')
    w = lc['wake']
    if not isinstance(w, dict) or 'cron' not in w or 'instant' not in w: errs.append('wake not {cron, instant}')
    else:
        if w['instant'] not in ('on', 'off'): errs.append('wake.instant not read back (on/off)')
        if not _cron_ok(w['cron']): errs.append('wake.cron not None/template dict(name,schedule,prompt)')
    wb = lc['wake_backup']
    if not isinstance(wb, dict) or 'cron' not in wb or 'instant' not in wb: errs.append('wake_backup not {cron, instant}')
    else:
        if wb['instant'] not in (None, 'on', 'off'): errs.append('wake_backup.instant not None/on/off')
        if not _cron_ok(wb['cron']): errs.append('wake_backup.cron not None/template dict(name,schedule,prompt)')
    cs = lc['children_seen']
    if not isinstance(cs, dict) or any(not (isinstance(k, str) and (v is None or _is_int(v))) for k, v in cs.items()): errs.append('children_seen not dict[str, int|None]')
    d = lc['decisions']
    if not isinstance(d, dict) or any(not isinstance(d.get(k), list) for k in ('out', 'in', 'in_early')) or any(not isinstance(x, dict) for k in ('out', 'in', 'in_early') for x in d.get(k) or []): errs.append('decisions not {out,in,in_early: [dict]}')
    b = lc['bubbles']
    if not isinstance(b, dict) or not isinstance(b.get('out'), list) or any(not isinstance(x, dict) for x in b.get('out') or []): errs.append('bubbles not {out: [dict]}')
    p = st.get('paused')
    if lc['status'] in STATUS_ENUM and (not isinstance(p, bool) or p != (lc['status'] == 'finished')): errs.append(f'top-level paused={p!r} inconsistent with lifecycle.status={lc["status"]!r}')
    return errs
def managed_state(st):
    """P5 是否可把该 state 当已迁移(managed)对象：schema>=4 ∧ lifecycle 深校验通过（全部键存在、类型/枚举/嵌套形态正确、paused 一致）∧ wake 已实物读回(instant∈on/off) ∧ 迁移来源 p5_managed.source∈{bootstrap,backfill,migrate}。
    其余（无 lifecycle 的 legacy、schema 3 却带 lifecycle 的污染态、无来源的 schema 4、类型损坏）一律非 managed：evaluator 不出 plan、父级视为 unknown、repair/recovery/簿记/outbox 全部零外写。返回 (bool, reason)。"""
    if not isinstance(st, dict): return False, 'no state'
    try: sv = int(st.get('schema_version') or 0)
    except Exception: sv = 0
    lc = st.get('lifecycle')
    if not isinstance(lc, dict): return False, 'legacy: no lifecycle'
    if sv < 4: return False, f'quarantine: schema {sv} with lifecycle (polluted; normalize via backfill --chat <id> --normalize-polluted)'
    errs = lifecycle_schema_errors(st)
    if errs: return False, f'quarantine: lifecycle schema invalid ({"; ".join(errs[:4])})'
    pm = st.get('p5_managed')
    if not isinstance(pm, dict) or pm.get('source') not in MANAGED_SOURCES: return False, 'quarantine: no migration provenance (p5_managed.source)'
    return True, f'managed via {pm.get("source")}'
def p_claims(chat): return os.path.join(P5_HOME, 'claims', f'{short(chat)}.jsonl')
def open_claims(chat):
    by = {}
    for r in read_jsonl(p_claims(chat)):
        by.setdefault(r['decision_id'], []).append(r)
    return {d: rs for d, rs in by.items() if rs[-1].get('phase') == 'claimed'}
def record_claim(did, parent, child, epoch, phase='claimed', reason=None):
    os.makedirs(os.path.join(P5_HOME, 'claims'), exist_ok=True)
    rec = {'decision_id': did, 'parent': parent, 'child': child, 'epoch': epoch, 'phase': phase, 'reason': reason, 'pid': os.getpid(), 'at': ts()}
    for c in {parent, child}: append_fsync(p_claims(c), rec)
def supersede_claims(chat, reason):
    for did, rs in open_claims(chat).items():
        r0 = rs[-1]; record_claim(did, r0['parent'], r0['child'], r0.get('epoch'), phase='superseded', reason=reason)
def lifecycle_hashes(state):
    """(精确 lifecycle sha, 去簿记/去时间戳 sha)：无 lifecycle dict → (None, None)。精确 sha 口径 = lifecycle_sha(lifecycle_of(st))，与 plan/repair 事务 intent/state_committed 记录一致。"""
    st = state or {}
    if not isinstance(st.get('lifecycle'), dict): return None, None
    lc = lifecycle_of(st); m = bookkeeping_masked(lc)
    for k in ('at', 'candidate_since', 'status_changed_at'): m.pop(k, None)
    return lifecycle_sha(lc), csha(m)
def write_state(chat, state):
    """所有 P5 写者的唯一落盘口：授权投影变化即 supersede 该 chat 的在途 claim（与 dispatch 共享可线性化的授权纪元）。
    S3 r4：lifecycle 精确 sha 有变化即在 journal 追加 kind=lifecycle_write {pre_sha, post_sha, pre_masked, post_masked, writer}——回退工具据此做逐段 hash 链校验（未经此口的 lifecycle 写 = 断链 = 拒绝回退）。"""
    pre_st = read_state(chat)
    try: before = auth_projection(pre_st)
    except Exception: before = None
    pre_sha, pre_m = lifecycle_hashes(pre_st); post_sha, post_m = lifecycle_hashes(state)
    atomic_write(p_state(chat), json.dumps(state, ensure_ascii=False, indent=1).encode())
    if pre_sha != post_sha:
        journal_append(chat, {'kind': 'lifecycle_write', 'pre_sha': pre_sha, 'post_sha': post_sha, 'pre_masked': pre_m, 'post_masked': post_m, 'writer': os.path.basename(sys.argv[0] or '?'), 'generation': (lifecycle_of(state).get('status_generation') if isinstance(state.get('lifecycle'), dict) else None)})
    after = auth_projection(state)
    if before != after:
        try: supersede_claims(chat, f'auth projection changed: {json.dumps({k: [before.get(k) if before else None, after.get(k)] for k in after if (before or {}).get(k) != after.get(k)}, ensure_ascii=False)[:300]}')
        except Exception as e: append_fsync(os.path.join(P5_HOME, 'claims', 'errors.jsonl'), {'chat': chat, 'error': str(e), 'at': ts()})
class AuthLocks:
    """固定顺序同时持有 parent+child 的 state 锁（按 chat id 排序），用于 dispatch claim → send → finalize 的线性化。"""
    def __init__(self, *chats): self.chats = sorted(set(chats)); self.locks = []
    def __enter__(self):
        for c in self.chats: self.locks.append(ChatLock(c).__enter__())
        return self
    def __exit__(self, *a):
        for l in reversed(self.locks): l.__exit__(*a)
def set_path(obj, path, value):
    ks = path.split('.'); cur = obj
    for k in ks[:-1]:
        if k not in cur or not isinstance(cur[k], (dict, list)): cur[k] = {}
        cur = cur[k]
    cur[ks[-1]] = value
def bookkeeping_write(chat, path, value):
    """簿记写：仅白名单路径；不 bump generation；锁内原子写。"""
    if not any(path == a or path.startswith(a + '.') for a in BOOKKEEPING_ALLOW):
        raise RuntimeError(f'bookkeeping path not allowed: {path}')
    with ChatLock(chat):
        st = read_state(chat) or {}
        ok, why = managed_state(st)
        if not ok: raise RuntimeError(f'bookkeeping refused: {short(chat)} not managed ({why})')  # 绝不在 legacy/污染态上写 lifecycle
        lc = lifecycle_of(st); set_path(lc, path, value); st['lifecycle'] = lc
        write_state(chat, st)
    return lc
def ledger_line(chat, text):
    p = p_ledger(chat)
    with open(p, 'a', encoding='utf-8') as f:
        f.write(f"| {now().strftime('%m-%d %H:%M')} | P5 | {text} |\n"); f.flush(); os.fsync(f.fileno())

# ---------- schedules / policies ----------
FIELDS9 = ('name', 'prompt', 'chatId', 'larkAppId', 'executionPosition', 'silent', 'enabled', 'workingDir', 'scope')
def load_schedules():
    p = p_schedules()
    if not os.path.exists(p): raise RuntimeError('schedules.json missing')
    d = json.load(open(p)); return d if isinstance(d, dict) else {t['id']: t for t in d}
# ---- observer wake cron 明确所有权（r3 P1-5）：三种显式凭据之一，不用关键词 ----
#  (1) 登记 ID：本群 state.lifecycle.wake.cron.id / wake_backup.cron.id，或 p5/wake-registry.json 里本群登记的 id（P5 自己 schedule_add 时登记）
#  (2) 精确模板：prompt 以 bootstrap-node.sh 的唯一模板开头，且模板里绑定的 process 文件就是本群的：
#      「你是「<群名>」(（…）)?的 observer 定时监测轮。读 ~/observer-records/process-<本群short>.md 严格照做」
#  其他一切 cron（不论 name/prompt 含不含 observer）都不归 P5：不计数、不触碰。
WAKE_PROMPT_RE = re.compile(r'^你是「[^」]+」(?:（[^）]*）)?的 observer 定时监测轮。读 ~/observer-records/process-(oc_[0-9A-Za-z]{8})\.md 严格照做')
def p_wake_registry(): return os.path.join(P5_HOME, 'wake-registry.json')
def registered_wake_ids(chat):
    ids = set()
    try:
        reg = json.load(open(p_wake_registry())) if os.path.exists(p_wake_registry()) else {}
        ids |= set(reg.get(chat, []))
    except Exception as e: raise RuntimeError(f'wake-registry unreadable: {e}')
    st = read_state(chat)
    if st and isinstance(st.get('lifecycle'), dict):
        lc = st['lifecycle']
        for w in (lc.get('wake') or {}, lc.get('wake_backup') or {}):
            c = w.get('cron') if isinstance(w, dict) else None
            if isinstance(c, dict) and c.get('id'): ids.add(c['id'])
    return ids
def register_wake(chat, sid):
    """跨 chat 全局 flock 下 RMW（r4 P2-3）：不同群的 apply/repair 并发登记不丢更新。"""
    os.makedirs(os.path.join(P5_HOME, 'locks'), exist_ok=True); lk = os.path.join(P5_HOME, 'locks', 'wake-registry.lock')
    fd = os.open(lk, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        p = p_wake_registry(); reg = json.load(open(p)) if os.path.exists(p) else {}
        reg.setdefault(chat, [])
        if sid not in reg[chat]: reg[chat].append(sid); atomic_write(p, json.dumps(reg, ensure_ascii=False, indent=1).encode())
    finally: os.close(fd)
WAKE_ENTRY_TYPES = {'name': str, 'prompt': str, 'chatId': str, 'larkAppId': str, 'executionPosition': str, 'silent': bool, 'enabled': bool, 'workingDir': str, 'scope': str, 'schedule': str}
def validate_wake_entries(chat):
    """v7 §6.5「本群 schedule/policy 条目字段齐全」：owned cron 的 9 字段 + schedule + parsed.kind 类型/取值齐全；instant=on 时 policy 条目必须绑定 observer app。返回错误列表。"""
    errs = []
    for e in cron_entries(chat):
        for k, ty in WAKE_ENTRY_TYPES.items():
            v = e.get(k)
            if v is None or not isinstance(v, ty) or (ty is str and not v.strip()): errs.append(f'cron {str(e.get("id"))[:8]}: field {k} missing/invalid')
        if e.get('chatId') != chat: errs.append(f'cron {str(e.get("id"))[:8]}: chatId mismatch')
        if e.get('larkAppId') != observer_app(): errs.append(f'cron {str(e.get("id"))[:8]}: larkAppId mismatch')
        if e.get('executionPosition') not in ('top-level', 'reply'): errs.append(f'cron {str(e.get("id"))[:8]}: executionPosition invalid')
        if not isinstance(e.get('parsed'), dict) or e['parsed'].get('kind') != 'cron' or not e['parsed'].get('expr'): errs.append(f'cron {str(e.get("id"))[:8]}: parsed.kind/expr invalid')
    pol = [x for x in load_policies().get('policies', []) if x.get('chatId') == chat]
    if len(pol) > 1: errs.append('policy: duplicate chat entries')
    if pol:
        io = pol[0].get('instantObserver')
        # 缺省/None = instant off（已拆唤醒的封存群就是这样）；一旦存在则字段必须齐全
        if io is not None and (not isinstance(io, dict) or not isinstance(io.get('enabled'), bool) or not isinstance(io.get('larkAppId'), str)): errs.append('policy: instantObserver fields missing/invalid')
        if instant_state(chat) == 'on' and (not isinstance(io, dict) or io.get('larkAppId') != observer_app()): errs.append('policy: instant on but not bound to observer app')
    return errs
def lark_bot_app():
    """lark-cli --as bot 发出的消息在 API 里的 sender app（个人号 profile 的 bot app）；未配置时退回 observer_app。ack 绑定用。"""
    return cfg().get('lark_bot_app') or observer_app()
def is_observer_cron(chat, e, registered=None):
    if e.get('id') and e['id'] in (registered if registered is not None else registered_wake_ids(chat)): return True
    m = WAKE_PROMPT_RE.match(e.get('prompt') or '')
    return bool(m and m.group(1) == short(chat))
def cron_entries(chat):
    reg = registered_wake_ids(chat)
    return [e for e in load_schedules().values() if e.get('chatId') == chat and e.get('parsed', {}).get('kind') == 'cron'
            and e.get('larkAppId') == observer_app() and e.get('enabled') is True and is_observer_cron(chat, e, reg)]
def entry9(e):
    d = {k: e.get(k) for k in FIELDS9}; d['id'] = e.get('id'); d['schedule'] = e.get('schedule')
    d['prompt_sha'] = sha256b((e.get('prompt') or '').encode()); return d
def load_policies():
    p = p_policies()
    if not os.path.exists(p): raise RuntimeError('chat-policies.json missing')
    return json.load(open(p))
def instant_state(chat):
    for e in load_policies().get('policies', []):
        if e.get('chatId') == chat:
            io = e.get('instantObserver') or {}
            if io.get('larkAppId') == observer_app(): return 'on' if io.get('enabled') else 'off'
            return 'off'
    return 'off'
def wake_actual(chat):
    cs = cron_entries(chat)
    return {'cron': [entry9(e) for e in cs], 'instant': instant_state(chat)}
def desired_for(status, cron_template=None):
    if status == 'active':
        d = {'cron': {'exactly_one': True}, 'instant': 'on'}
        if cron_template:
            d['cron'].update({k: cron_template.get(k) for k in FIELDS9 if k != 'prompt'}); d['cron']['schedule'] = cron_template.get('schedule'); d['cron']['prompt_sha'] = cron_template.get('prompt_sha')
        return d
    if status == 'paused': return {'cron': {'count': 0}, 'instant': 'on'}
    if status == 'finished': return {'cron': {'count': 0}, 'instant': 'off'}
    if status == 'unmanaged': return {'cron': {'count': 0}, 'instant': 'on'}
    raise ValueError(status)
def satisfies(actual, desired):
    if desired.get('instant') and actual['instant'] != desired['instant']: return False
    dc = desired['cron']
    if 'count' in dc: return len(actual['cron']) == dc['count']
    if dc.get('exactly_one'):
        if len(actual['cron']) != 1: return False
        c = actual['cron'][0]
        for k, v in dc.items():
            if k in ('exactly_one',): continue
            if v is not None and c.get(k) != v: return False
        return True
    return False
def run(cmd, input=None, timeout=120):
    r = subprocess.run(cmd, capture_output=True, text=True, input=input, timeout=timeout)
    return r.returncode, r.stdout, r.stderr

def quoted_message(m, *, raw=False):
    """Hydrate a card in the SAME reader app view as list_messages.

    GateA owns the registry/directory parsing; do not grow a second allowlist.
    The selected live session is only a reader, not task authorization.
    """
    import importlib.util
    app=m.get('_reader_app_id')
    if not app: raise RuntimeError('quoted missing actual list reader app')
    if os.environ.get('BOTMUX_LARK_APP_SECRET'): raise RuntimeError('env-only quoted reader not supported')
    source=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),'bin','verify-prod-spawn-authz.py')
    spec=importlib.util.spec_from_file_location('_p5_gatea_reader',source); gate=importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
    # This module instance is private to this read. Avoid redirect_stdout:
    # redirecting process-global stdout races when card reads run concurrently.
    def reader_error(message): raise RuntimeError(message)
    gate.out=reader_error
    directory=gate.data_dir(); candidates=[]
    paths=glob.glob(os.path.join(directory,'sessions-*.json'))+[os.path.join(directory,'sessions.json')]
    for path in paths:
        if not os.path.isfile(path): continue
        data=json.load(open(path)); values=data.values() if isinstance(data,dict) else data if isinstance(data,list) else []
        for row in values:
            if isinstance(row,dict) and row.get('larkAppId')==app and row.get('status')=='active' and row.get('sessionId'):
                candidates.append(row)
    candidates.sort(key=lambda r:(r.get('chatId')!=m.get('chat_id'),r['sessionId']))
    if not candidates: raise RuntimeError('no active quoted reader for '+app)
    sid=candidates[0]['sessionId']
    def identity():
        actual,row,path=gate.resolve_reader(sid,directory)
        if actual!=app or row.get('status')!='active': raise RuntimeError('quoted reader drift')
        return (actual,row.get('sessionId'),row.get('chatId'),row.get('status'),path)
    before=identity()
    argv=[BOTMUX_BIN,'quoted',m['message_id'],'--session-id',sid]
    if raw: argv.append('--raw')
    pr=subprocess.run(argv,capture_output=True,text=True,timeout=60,env=dict(os.environ,SESSION_DATA_DIR=directory,BOTMUX_LARK_APP_ID=app))
    if pr.returncode: raise RuntimeError('quoted failed rc='+str(pr.returncode)+' '+pr.stderr[:120])
    if identity()!=before: raise RuntimeError('quoted registry changed during read')
    q=parse_json_tail(pr.stdout); sender=m.get('sender',{})
    if q.get('messageId')!=m['message_id'] or q.get('senderId')!=sender.get('id') or q.get('senderType')!=sender.get('sender_type'):
        raise RuntimeError('quoted message/reader identity mismatch')
    return q

def exact_single_mention(m,allowed):
    """mget normalizes bot mentions to app IDs; list can expose scoped open IDs."""
    mentions=m.get('mentions') or []
    if len(mentions)!=1: return False
    if mentions[0].get('id') in allowed: return True
    app=m.get('_reader_app_id')
    readers=[r for r in transport_readers() if r['app_id']==app]
    if not readers: return False
    profile=readers[0]['profile']
    rc,out,err=run([LARK_BIN,'im','+messages-mget','--message-ids',m['message_id'],'--profile',profile,'--as','bot','--no-reactions'],timeout=60)
    if rc: raise RuntimeError('exact mention mget failed: '+err[:120])
    rows=(parse_json_tail(out).get('data') or {}).get('messages') or []
    if len(rows)!=1: return False
    actual=rows[0]
    if actual.get('message_id')!=m['message_id'] or actual.get('chat_id')!=m.get('chat_id') or actual.get('sender',{}).get('id')!=m.get('sender',{}).get('id'): return False
    return len(actual.get('mentions') or [])==1 and actual['mentions'][0].get('id') in allowed
def schedule_add(tpl, chat):
    cmd = [BOTMUX_BIN, 'schedule', 'add', tpl['schedule'], tpl['prompt'], '--name', tpl['name'], '--chat-id', chat, '--lark-app-id', tpl['larkAppId']]
    if tpl.get('executionPosition') == 'top-level': cmd.append('--top-level')
    if tpl.get('silent'): cmd.append('--silent')
    if tpl.get('workingDir'): cmd += ['--workdir', tpl['workingDir']]
    before = set(load_schedules().keys()); rc, out, err = run(cmd)
    if rc != 0: raise RuntimeError(f'schedule add failed rc={rc} {err[:200]}')
    new_ids = [k for k, e in load_schedules().items() if k not in before and e.get('chatId') == chat and e.get('parsed', {}).get('kind') == 'cron']
    for k in new_ids: register_wake(chat, k)
    if not new_ids: raise RuntimeError('schedule add: no new cron entry found after add (cannot register ownership)')
    return out
def schedule_remove(sid):
    rc, out, err = run([BOTMUX_BIN, 'schedule', 'remove', sid, '--lark-app-id', observer_app()])
    if rc != 0: raise RuntimeError(f'schedule remove failed rc={rc} {err[:200]}')
def instant_prompt_for(chat):
    """候选/首次开 instant 时写入的标准 observer 事件轮 prompt（config.instant_prompt_template，{short} 占位）；无模板返回 None（daemon 用其缺省 prompt）。"""
    t = cfg().get('instant_prompt_template')
    return t.replace('{short}', short(chat)) if t else None
OWNED_KEYS = ('lifecycle', 'p5_managed', 'schema_version', 'paused')  # backfill 写的 P5 自有字段；回退只逆向这些，业务字段（tasks/notes/logs…）一律保留
def owned_fields(st): return {k: (st or {}).get(k) for k in OWNED_KEYS}
def bookkeeping_masked(lc):
    """去掉 P5 簿记（journal 后继允许变化的部分）后的 lifecycle，用于 postimage CAS。"""
    if not isinstance(lc, dict): return lc
    m = json.loads(json.dumps(lc))
    for k in ('wake_checked_at', 'children_seen', 'decisions', 'bubbles'): m.pop(k, None)
    for k in ('finish_pending', 'reopen_pending'):
        if isinstance(m.get(k), dict): m[k] = {kk: vv for kk, vv in m[k].items() if kk != 'asks'}
    return m
def cron_template_for(chat, st=None):
    """候选/无 cron 群的 observer cron 模板（config.cron_template，{short}/{group} 占位），entry9 形态（id=None，prompt_sha 计算）；无配置返回 None。"""
    t = cfg().get('cron_template')
    if not t: return None
    st = st if isinstance(st, dict) else (read_state(chat) or {}); g = st.get('group') or short(chat)
    e = {k: (v.replace('{short}', short(chat)).replace('{group}', g) if isinstance(v, str) else v) for k, v in t.items()}
    d = {k: e.get(k) for k in FIELDS9}; d['chatId'] = chat; d['enabled'] = True; d['id'] = None; d['schedule'] = e.get('schedule'); d['prompt_sha'] = sha256b((d.get('prompt') or '').encode())
    if not WAKE_PROMPT_RE.match(d.get('prompt') or '') or WAKE_PROMPT_RE.match(d['prompt']).group(1) != short(chat): raise RuntimeError('cron_template prompt does not match WAKE_PROMPT_RE for this chat')
    return d
def instant_set(chat, on: bool, prompt=None):
    cmd = [BOTMUX_BIN, 'watch', 'set', '--chat', chat, '--instant', 'on' if on else 'off']
    if on: cmd += ['--instant-app', observer_app(), '--instant-debounce', '90']
    if on and prompt: cmd += ['--instant-prompt', prompt]
    rc, out, err = run(cmd)
    if rc != 0: raise RuntimeError(f'watch set failed rc={rc} {err[:200]}')
def others_unchanged(before: dict, after: dict, exclude_ids):
    """schedule 差分：除 exclude_ids 外逐 ID 完整字段不变（daemon 自己刷新的 lastRunAt/nextRunAt/lastStatus 忽略）。"""
    vol = ('lastRunAt', 'nextRunAt', 'lastStatus', 'updatedAt')
    strip = lambda e: {k: v for k, v in e.items() if k not in vol}
    for k, v in before.items():
        if k in exclude_ids: continue
        if k not in after or strip(after[k]) != strip(v): return False, k
    for k in after:
        if k not in before and k not in exclude_ids and not str(k).startswith('inst_') and not after[k].get('name', '').startswith('observer事件轮'):
            # 期间由 daemon/worker 新增的 one-shot 允许（非 cron）
            if after[k].get('parsed', {}).get('kind') == 'cron': return False, k
    return True, None

# ---------- Lark 消息 ----------
def parse_json_tail(t):
    i = t.find('{');
    if i < 0: raise RuntimeError('no json in output')
    return json.loads(t[i:])
def list_messages(chat, start=None, page_size=50, max_pages=None):
    """按时间边界分页读消息（desc）。start: datetime；读到 create_time < start 即停。任何一页失败、或页数用尽仍未到边界 → 抛异常（fail-closed，绝不静默截断）。"""
    max_pages = max_pages or int(os.environ.get('P5_MAX_PAGES', '400')); msgs, token, pages = [], None, 0
    while True:
        readers=transport_readers()
        attempts = [[LARK_BIN, 'im', '+chat-messages-list', '--profile', r['profile'], '--as', r['as'], '--chat-id', chat, '--page-size', str(page_size), '--order', 'desc'] for r in readers]
        last_err = ''
        for reader,base in zip(readers,attempts):
            cmd = list(base)
            if token: cmd += ['--page-token', token]
            rc, out, err = run(cmd, timeout=60)
            if rc == 0:
                break
            last_err = err
        else:
            raise RuntimeError(f'lark list failed rc={rc} {last_err[:200]}')
        d = parse_json_tail(out)
        if not d.get('ok', True) and 'data' not in d: raise RuntimeError('lark list not ok')
        data = d['data']; page = data.get('messages', [])
        for m in page:
            # Preserve which configured app view produced app-scoped user IDs.
            # A bot identity is app_id and is stable; user open_id is not.
            m['_reader_app_id']=reader['app_id']
            msgs.append(m)
        pages += 1
        if start and page and msg_time(page[-1]) < start: break
        if not data.get('has_more') or not data.get('page_token'): break
        if pages >= max_pages: raise RuntimeError(f'pagination exhausted at {pages} pages before reaching boundary (fail-closed)')
        token = data['page_token']
    return msgs
def msg_time(m):
    if m.get('_quoted_create_time_ms'):
        return datetime.datetime.fromtimestamp(int(m['_quoted_create_time_ms'])/1000,BJ)
    ct = str(m.get('create_time') or '')
    if len(ct) >= 19:
        try: return datetime.datetime.strptime(ct[:19], '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)
        except Exception: pass
    return datetime.datetime.strptime(ct[:16], '%Y-%m-%d %H:%M').replace(tzinfo=BJ)
def msg_later(a, b, msgs):
    """a 是否晚于 b：先比 create_time（秒级若有）；同一时刻用同一分页快照（desc）里的稳定顺序（索引小=更新）；任一不在快照 → False（fail-closed）。"""
    ta, tb = msg_time(a), msg_time(b)
    if ta != tb: return ta > tb
    ids = [x.get('message_id') for x in msgs]
    if a.get('message_id') not in ids or b.get('message_id') not in ids: return False
    return ids.index(a['message_id']) < ids.index(b['message_id'])
def msg_text(m):
    if m.get('msg_type') in ('interactive','post') and configured_delegation_chat(m['chat_id']):
        if '_quoted_content' not in m:
            try:  # hydration 失败/无 reader 时回退普通正文，P5 事实层不因卡片补水 traceback
                q = quoted_message(m) or {}; m['_quoted_content'] = q.get('content') or ''
                if q.get('createTime'): m['_quoted_create_time_ms'] = q['createTime']
            except Exception as e:
                c0 = m.get('content'); m['_quoted_content'] = c0 if isinstance(c0, str) else ''; m['_quoted_error'] = str(e)[:120]
        return m['_quoted_content']
    c = m.get('content')
    if isinstance(c, str): return c
    b = m.get('body', {}).get('content') if isinstance(m.get('body'), dict) else None
    return b if isinstance(b, str) else json.dumps(c or b or '', ensure_ascii=False)
def sender_kind(m):
    s = m.get('sender', {})
    if s.get('sender_type') == 'app' and s.get('id_type') == 'app_id':
        aid = s.get('id')
        if aid == observer_app(): return 'observer'
        if aid in noise_apps(): return 'noise'
        if aid in executor_apps(): return 'executor'
        return 'app'
    if s.get('sender_type') == 'user': return 'user'
    return 'other'
def lark_probe(chat):
    """heartbeat 用：单次 list 调用，只看 rc + JSON 可解析 + 返回 messages 数组；不翻页、不要求到时间边界。"""
    reader=transport_readers()[0]
    rc, out, err = run([LARK_BIN, 'im', '+chat-messages-list', '--profile', reader['profile'], '--as', reader['as'], '--chat-id', chat, '--page-size', '5', '--order', 'desc'], timeout=60)
    if rc != 0: raise RuntimeError(f'lark probe rc={rc} {err[:200]}')
    d = parse_json_tail(out); items = (d.get('data') or {}).get('messages')
    if not isinstance(items, list): raise RuntimeError('lark probe: no messages array')
    return len(items)
def send_message(chat, text, as_user=False, idempotency_key=None):
    cmd = [LARK_BIN, 'im', '+messages-send', '--profile', transport_sender_profile(), '--as', 'user' if as_user else 'bot', '--chat-id', chat, '--text', text]
    if idempotency_key: cmd += ['--idempotency-key', idempotency_key]
    rc, out, err = run(cmd, timeout=60)
    if rc != 0: raise RuntimeError(f'send failed rc={rc} {err[:200]}')
    d = parse_json_tail(out); return (d.get('data') or {}).get('message_id')

# ---------- marker ----------
MARK_RE = re.compile(r'\[p5:([A-Za-z0-9_\-=]+)\]')
MARK_CANDIDATE_RE = re.compile(r'\[p5:([^\]]*)(\]|$)')
# 写端仍用 encode_marker 的 URL-safe base64；读端兼容标准 base64 的 + 和 /。非 base64 字符的候选
# （如会话卡标题里截断的 [p5:… — 工作中]）必然不是 marker，扫描时跳过而非 raise，避免噪音消息打崩 in-scan。
MARK_BASE64_ALPHABET_RE = re.compile(r'[A-Za-z0-9_\-+/=]+')
def encode_marker(obj):
    return '[p5:' + base64.urlsafe_b64encode(canonical(obj).encode()).decode().rstrip('=') + ']'
def find_markers(text):
    out = []
    # Read both alphabets; reject corrupt encoded data, skip prose placeholders.
    # encode_marker keeps its existing canonical URL-safe output.
    for number, match in enumerate(MARK_CANDIDATE_RE.finditer(text or ''), 1):
        try:
            g, closing = match.groups()
            if not MARK_BASE64_ALPHABET_RE.fullmatch(g):
                continue  # 散文无需闭括号；仅编码候选才进入协议格式检查。
            if not closing: raise ValueError('missing closing bracket')
            pad = '=' * (-len(g) % 4)
            out.append(json.loads(base64.b64decode(g + pad, altchars=b'-_', validate=True).decode()))
        except Exception as error:
            raise ValueError(f'invalid p5 marker #{number} offset={match.start()}: {error}') from error
    return out

# ---------- taskbook 有效性 ----------
def taskbook_message_text(m):
    """Fresh authorization evidence, never a cached hydration/fallback body.

    Ordinary P5 text fixtures retain their existing path. Delegation cards must
    pass the same registry-bound reader as before, including nonzero rc checks.
    """
    if m.get('msg_type') in ('interactive','post') and configured_delegation_chat(m['chat_id']):
        q=quoted_message(m)
        m['_quoted_content']=q.get('content') or ''
        m.pop('_quoted_error',None)
        m.pop('_quoted_create_time_ms',None)
        if q.get('createTime'): m['_quoted_create_time_ms']=q['createTime']
        return m['_quoted_content']
    return msg_text(m)

def taskbook_status(chat, msgs):
    from concurrent.futures import ThreadPoolExecutor
    p = p_taskbook(chat)
    if not os.path.exists(p): return {'valid': False, 'reason': 'taskbook missing'}
    sha = sha256b(open(p, 'rb').read())
    idx = [r for r in read_jsonl(p_tbindex()) if r.get('chat') == chat]
    if not idx: return {'valid': False, 'reason': 'no index', 'sha': sha}
    last = idx[-1]
    if last.get('sha') != sha: return {'valid': False, 'reason': 'sha mismatch vs index', 'sha': sha}
    candidates=[m for m in msgs if sender_kind(m)=='executor']
    # Bounded read-ahead, but consume in the ORIGINAL snapshot order. A later
    # worker finishing first must not hide a newer announcement or read error.
    # No persistent cache/index and no change to basis/announcement ordering.
    with ThreadPoolExecutor(max_workers=8) as pool:
        for offset in range(0,len(candidates),8):
            batch=candidates[offset:offset+8]
            jobs=[pool.submit(taskbook_message_text,m) for m in batch]
            for m,job in zip(batch,jobs):
                try: text=job.result()
                except Exception as e:
                    return {'valid':False,'reason':'announcement readback failed: '+str(e),'sha':sha}
                for mk in find_markers(text):
                    if mk.get('taskbook_sha') == sha and mk.get('gen') == last.get('gen'):
                        current=[r for r in read_jsonl(p_tbindex()) if r.get('chat')==chat]
                        if not current or current[-1]!=last or sha256b(open(p,'rb').read())!=sha:
                            return {'valid':False,'reason':'taskbook/index changed during readback','sha':sha}
                        return {'valid': True, 'sha': sha, 'gen': last.get('gen'), 'announce': m['message_id']}
    return {'valid': False, 'reason': 'no executor announcement', 'sha': sha}
def taskbook_nodes(chat):
    """解析 taskbook 中的结构化节点行：`- node <id> kind=human owner=<open_id> created=<YYYY-MM-DD HH:MM> role=<role>`。"""
    p = p_taskbook(chat); nodes = {}
    if not os.path.exists(p): return nodes
    for l in open(p, encoding='utf-8'):
        m = re.match(r'^\s*-\s*node\s+(\S+)\s+(.*)$', l.strip())
        if not m: continue
        nid, rest = m.group(1), m.group(2); attrs = dict(re.findall(r'(\w+)=(\S+(?: \d\d:\d\d)?)', rest))
        nodes[nid] = attrs
    return nodes

# ---------- 任务分类（§3.2/3.3） ----------
def classify_tasks(chat, state, msgs, tb, role_apps):
    tasks = (state or {}).get('tasks') or {}
    nodes = taskbook_nodes(chat) if tb.get('valid') else {}
    byid = {m['message_id']: m for m in msgs}
    used_msgs = set(); res = {}
    def created_of(nid):
        c = nodes.get(nid, {}).get('created')
        try: return datetime.datetime.strptime(c, '%Y-%m-%d %H:%M').replace(tzinfo=BJ) if c else None
        except Exception: return None
    owner_ids = {o.get('owner_open_id') for o in cfg().get('owners', []) if o.get('owner_open_id')}
    for tid, t in tasks.items():
        if not isinstance(t, dict): res[tid] = {'cls': 'undecidable', 'why': 'legacy non-dict task'}; continue
        st = t.get('status'); ev = t.get('evidence') or {}; kind = t.get('kind')
        if not isinstance(ev, dict): ev = {}
        cls, why = 'undecidable', ''
        if st in ('done', 'void'):
            if st == 'void' and ev.get('kind') == 'taskbook_node' and tb.get('valid') and ev.get('node_id') == tid and ev.get('taskbook_sha') == tb.get('sha') and nodes.get(tid, {}).get('status') == 'void': cls = 'terminal'
            elif st == 'done' and ev.get('kind') == 'bot_message':
                m = byid.get(ev.get('message_id'))
                if m and m['message_id'] not in used_msgs and m.get('sender', {}).get('sender_type') == 'app' and m['sender'].get('id_type') == 'app_id' and m['sender'].get('id') == ev.get('app_id'):
                    role = ev.get('role'); exp_app = role_apps.get(role)
                    ok = exp_app == ev.get('app_id') and ev.get('node_id') == tid
                    # 同一消息里所有匹配 node/round/role 的 marker：任一 NOT PASS 即否决；必须恰好一个 verdict ∈ {done, PASS}
                    mk = [k for k in find_markers(msg_text(m)) if k.get('node') == tid and k.get('round') == ev.get('round') and k.get('role') == role]
                    verdicts = [k.get('verdict') for k in mk]
                    c0 = created_of(tid)
                    if ok and mk and 'NOT PASS' not in verdicts and len(verdicts) == 1 and verdicts[0] in ('done', 'PASS') and (c0 is None or msg_time(m) > c0) and (tb.get('valid') if nodes else True):
                        cls = 'terminal'; used_msgs.add(m['message_id'])
                    else: why = f'marker/role/time check failed (verdicts={verdicts})'
                else: why = 'message not found or sender mismatch'
            else: why = 'no valid evidence for terminal'
        elif kind == 'human':
            nd = nodes.get(tid, {})
            if (ev.get('kind') == 'taskbook_node' and tb.get('valid') and ev.get('taskbook_sha') == tb.get('sha') and ev.get('node_id') == tid
                    and ev.get('taskbook_gen') is not None and ev.get('taskbook_gen') == tb.get('gen') and nd.get('kind') == 'human' and nd.get('owner') in owner_ids and st in ('in_progress', 'blocked')):
                cls = 'owner_blocked'
            else: why = 'human node without valid taskbook evidence (owner/node/gen/sha)'
        elif st == 'todo':
            deps = t.get('deps') or []
            cls = 'todo'; res[tid] = {'cls': cls, 'deps': deps}; continue
        elif st == 'blocked' and str(t.get('blocked_on', '')).startswith(('task:', 'external:')): cls, why = 'blocked', 'ordinary blocked'
        else: why = f'status={st}'
        res[tid] = {'cls': cls, 'why': why}
    # todo 传递：deps 全为 owner_blocked → owner_blocked；否则 undecidable
    changed = True
    while changed:
        changed = False
        for tid, r in res.items():
            if r['cls'] == 'todo':
                deps = r.get('deps') or []
                if deps and all(res.get(d, {}).get('cls') == 'owner_blocked' for d in deps): r['cls'] = 'owner_blocked'; changed = True
                elif not deps or any(d not in res for d in deps): r['cls'] = 'undecidable'; r['why'] = 'todo without resolvable deps'; changed = True
    return res
def only_waiting_owner(cls):
    if not cls: return False, 'no tasks'
    bad = [t for t, r in cls.items() if r['cls'] not in ('terminal', 'owner_blocked')]
    if bad: return False, f'not owner-blocked: {bad[:5]}'
    return True, 'all terminal or owner-blocked'

# ---------- 进程 / 会话 / 空闲证明（§3.4） ----------
def proc_provider():
    fx = os.environ.get('P5_PROC_FIXTURE')
    if fx: return json.load(open(fx))
    procs = []
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try: env = open(f'/proc/{pid}/environ', 'rb').read().decode(errors='ignore').split('\0')
        except Exception: continue
        kv = dict(e.split('=', 1) for e in env if '=' in e)
        if 'BOTMUX_CHAT_ID' in kv:
            procs.append({'pid': int(pid), 'chat': kv.get('BOTMUX_CHAT_ID'), 'sid': kv.get('BOTMUX_SESSION_ID'), 'app': kv.get('BOTMUX_LARK_APP_ID')})
    rc, out, _ = run(['tmux', 'ls'])
    tmux = [l.split(':')[0] for l in out.splitlines() if l.startswith('bmx-')] if rc == 0 else []
    return {'procs': procs, 'tmux': tmux, 'cli_terminal': None, 'daemon_idle': None}
def sessions_for_chat(chat):
    out = []
    for f in glob.glob(os.path.join(BOTMUX_HOME, 'data', 'sessions-*.json')):
        app = os.path.basename(f)[9:-5]
        try: s = json.load(open(f))
        except Exception: continue
        s = s if isinstance(s, list) else list(s.values())
        for x in s:
            if x.get('chatId') == chat: out.append({'sid': x.get('sessionId'), 'app': app, 'status': x.get('status'), 'pid': x.get('pid')})
    return out
def daemon_idle_after_inject(sid8):
    """所有 daemon-*-out.log 合并：最后 idle 标记晚于最后 inject/spawn。"""
    ev = []
    for f in glob.glob(os.path.join(BOTMUX_HOME, 'logs', 'daemon-*-out.log')):
        try:
            for l in open(f, encoding='utf-8', errors='ignore'):
                if sid8 not in l: continue
                m = re.match(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)', l)
                if not m: continue
                if 'Prompt detected (idle)' in l: ev.append((m.group(1), 'idle'))
                elif 'injected into live session' in l or 'cold-resumed session' in l or 'Spawning fresh CLI' in l: ev.append((m.group(1), 'inject'))
        except Exception: return None
    if not ev: return None
    ev.sort(); return ev[-1][1] == 'idle'
def cli_terminal(sid):
    for f in glob.glob(os.path.expanduser(f'~/.pi/agent/sessions/*/*{sid}.jsonl')):
        rows = [json.loads(l) for l in open(f) if l.strip()]
        ms = [r for r in rows if r.get('type') == 'message']
        return bool(ms) and ms[-1]['message'].get('role') == 'assistant' and ms[-1]['message'].get('stopReason') == 'stop'
    for f in glob.glob(os.path.expanduser(f'~/.claude/projects/*/{sid}.jsonl')):
        last = None
        for l in open(f):
            try: d = json.loads(l)
            except Exception: continue
            if d.get('type') in ('assistant', 'user'): last = d
        return bool(last) and last.get('type') == 'assistant' and (last.get('message') or {}).get('stop_reason') in ('end_turn', 'stop_sequence')
    for f in glob.glob(os.path.expanduser('~/.codex/sessions/**/*.jsonl'), recursive=True):
        if sid[:8] not in open(f).read(4000): continue
        last = None
        for l in open(f):
            try: d = json.loads(l)
            except Exception: continue
            if d.get('type') == 'event_msg' and (d.get('payload') or {}).get('type') in ('task_complete', 'task_started', 'agent_message'): last = d
        return bool(last) and last['payload']['type'] == 'task_complete'
    return None
def nobody_working(chat, observer_sid=None):
    pv = proc_provider(); cands = {}
    for s in sessions_for_chat(chat):
        if s['sid']: cands.setdefault(s['sid'], {'sid': s['sid'], 'app': s['app'], 'src': set()})['src'].add('sessions')
    for p in pv.get('procs', []):
        if p.get('chat') != chat: continue
        if not p.get('sid'): return False, f'unmapped live process pid={p.get("pid")}'
        cands.setdefault(p['sid'], {'sid': p['sid'], 'app': p.get('app'), 'src': set()})['src'].add('proc')
    alive = {p['sid'] for p in pv.get('procs', []) if p.get('chat') == chat}
    for t in pv.get('tmux', []):
        m = [s for s in cands if s.startswith(t[4:])]
        if t.startswith('bmx-') and len(m) == 1: cands[m[0]]['src'].add('tmux')
    for sid, c in cands.items():
        if sid == observer_sid or c.get('app') == observer_app(): continue
        proc_alive = sid in alive
        if not proc_alive and 'tmux' not in c['src']: continue  # 进程不存在 → 该 session 不在干活
        idle = pv.get('daemon_idle', {}).get(sid) if isinstance(pv.get('daemon_idle'), dict) else daemon_idle_after_inject(sid[:8])
        term = pv.get('cli_terminal', {}).get(sid) if isinstance(pv.get('cli_terminal'), dict) else cli_terminal(sid)
        if idle is not True: return False, f'session {sid[:8]}: no idle proof'
        if term is not True: return False, f'session {sid[:8]}: cli terminal unreadable/busy'
    return True, 'idle proven'

# ---------- 子群 / 心跳 / journal ----------
def child_lifecycles(state):
    out = {}
    for c in (state or {}).get('children') or []:
        st = read_state(c)
        ok, why = managed_state(st)
        if not ok: out[c] = {'status': 'unknown', 'reason': why}; continue
        lc = lifecycle_of(st); s = lc['status']
        if s == 'active':
            wc = lc.get('wake_checked_at')
            try: age = (now() - datetime.datetime.strptime(wc, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)).total_seconds() if wc else None
            except Exception: age = None
            if age is None or age > CHILD_STALE_SEC: out[c] = {'status': 'unknown', 'reason': 'stale wake_checked_at', 'generation': lc['status_generation']}; continue
        out[c] = {'status': s, 'generation': lc['status_generation'], 'changed_at': lc.get('status_changed_at')}
    return out
def heartbeat():
    p = p_heartbeat()
    if not os.path.exists(p): return {'healthy_age': None, 'attempt_age': None}
    try: h = json.load(open(p))
    except Exception: return {'healthy_age': None, 'attempt_age': None}
    def age(k):
        v = h.get(k)
        if not v: return None
        return (now() - datetime.datetime.strptime(v, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)).total_seconds()
    return {'healthy_age': age('last_healthy_at'), 'attempt_age': age('last_attempt_at'), 'last_error': h.get('last_error')}
def write_heartbeat(healthy, error=None, attempt_only=False):
    """attempt_only=True：timer 运行开始即写 last_attempt_at；结束时 healthy 才推进 last_healthy_at。"""
    p = p_heartbeat(); h = {}
    if os.path.exists(p):
        try: h = json.load(open(p))
        except Exception: h = {}
    if attempt_only: h['last_attempt_at'] = ts(); h['running'] = True
    else:
        h['running'] = False
        if healthy: h['last_healthy_at'] = ts(); h['last_error'] = None
        else: h['last_error'] = error
    atomic_write(p, json.dumps(h).encode())
def journal(chat): return read_jsonl(p_journal(chat))
def journal_last(chat, plan_sha):
    rs = [r for r in journal(chat) if r.get('kind') == 'plan' and r.get('plan_sha') == plan_sha]
    return rs[-1] if rs else None
def journal_append(chat, rec):
    rs = journal(chat); rec = dict(rec); rec['seq'] = (rs[-1]['seq'] + 1) if rs else 1; rec['at'] = ts()
    append_fsync(p_journal(chat), rec); return rec
def journal_head_seq(chat):
    rs = journal(chat); return rs[-1]['seq'] if rs else 0
def receipts(chat, proposal_id):
    return [r for r in journal(chat) if r.get('kind') == 'actor_receipt' and r.get('proposal_id') == proposal_id]
def valid_receipt(chat, pending, expected_generation, lc, kind='finish'):
    """取 attempt 最大且有 receipt 的；校验 §5.1-4。返回 (receipt|None, reason)。
    r13 P1-1：receipt 自报的 ask_lark_app_id 必须逐字等于 pending 中同 attempt 持久化的 ask_lark_app_id，且该 app 必须是 kind 的 scope app（finish=observer_app、reopen=执行者 app）；
    owner 按**持久化的** ask app 查（不是按 receipt 自报的 app）。"""
    if not pending: return None, 'no pending'
    if kind not in ('finish', 'reopen'): return None, f'unknown pending kind {kind!r}'
    rs = receipts(chat, pending['proposal_id'])
    if not rs: return None, 'no receipt'
    r = max(rs, key=lambda x: x.get('attempt', 0)); pl = r.get('payload', {})
    asks = {a.get('attempt'): a for a in pending.get('asks', []) if isinstance(a, dict)}; a = asks.get(r.get('attempt'))
    if not a: return None, 'receipt attempt not in pending.asks'
    if pl.get('rc') != 0 or pl.get('timedOut') or pl.get('selected') != 'confirm': return None, f'receipt not confirm: {pl}'
    ask_app = a.get('ask_lark_app_id')
    if not isinstance(ask_app, str) or pl.get('ask_lark_app_id') != ask_app: return None, f'receipt ask app {pl.get("ask_lark_app_id")!r} != pending attempt ask app {ask_app!r}'
    if ask_app != ask_app_for(kind, chat): return None, f'ask app {ask_app!r} is not the {kind} scope app {ask_app_for(kind, chat)!r}'
    owner = owner_id_for_app(ask_app)
    if not owner or pl.get('by') != owner: return None, 'by mismatch for ask app scope'
    if pl.get('at', '') < a.get('started_at', ''): return None, 'receipt before ask started'
    if lc['status_generation'] != expected_generation: return None, 'generation changed since pending'
    return r, 'valid'
