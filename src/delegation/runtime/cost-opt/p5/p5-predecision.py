#!/usr/bin/env python3
"""Existing observer's pre-decision check/receipt helper; NOT a sender.

scan CHAT; reserve CHAT ID --reader-session SID --declared-app APP;
reconcile CHAT ID [same observer credentials].
Uses the original basis/chain guards and journal. Never creates decisions,
payloads, bindings, bubbles, schedules or a second delivery queue. The observer
keeps its existing user-identity routing, then records actual receipts here.
Saves repeated human nudges; no runtime hook is installed by this module.
"""
import argparse, copy, importlib.util
from p5lib import *

KIND='observer_predecision'

def module(name, file=None):
    # p5-decision's CLI defines helpers at module scope. An unmatched library
    # operation loads those exact helpers without calling a command/creating I/O.
    argv=sys.argv; sys.argv=[name,'__library__']
    try:
        spec=importlib.util.spec_from_file_location(name,file or os.path.join(os.path.dirname(__file__),name+'.py'))
        obj=importlib.util.module_from_spec(spec); spec.loader.exec_module(obj); return obj
    finally: sys.argv=argv

D=module('p5-decision')

def rows(chat): return [r for r in journal(chat) if r.get('kind')==KIND]
def latest(chat,cid): return next((r for r in reversed(rows(chat)) if r.get('continuation_id')==cid),None)
def history(chat,cid): return [r for r in rows(chat) if r.get('continuation_id')==cid]
def record(chat,plan,phase,**details):
    # Caller holds ChatLock. This is an observation receipt in the existing
    # journal, never a sendable outbox item; only the observer sends, at most once.
    return journal_append(chat,dict(kind=KIND,continuation_id=plan['continuation_id'],
        plan=plan,phase=phase,whole_task_complete=False,**details))

def observer_identity(chat,sid,declared):
    if not sid or not declared: raise ValueError('observer registry identity required')
    if os.environ.get('BOTMUX_LARK_APP_SECRET'): raise ValueError('env-only observer forbidden')
    gate=module('predecision_reader',os.path.join(os.path.dirname(__file__),'../../bin/verify-prod-spawn-authz.py'))
    def bad(message): raise ValueError(message)
    gate.out=bad
    app,row,path=gate.resolve_reader(sid,gate.data_dir())
    if app!=declared or app!=observer_app() or row.get('chatId')!=chat or row.get('status')!='active':
        raise ValueError('caller is not the active registered observer in this chat')
    return dict(app=app,sid=sid,registry=path,chat=chat)

def idle(chat):
    # Absence of processes alone does NOT prove a completed executor turn.
    sessions=[s for s in sessions_for_chat(chat) if s['app']==executor_app(chat) and s['status']=='active']
    if len(sessions)!=1: return False,'need one registered active executor session'
    sid=sessions[0]['sid']; pv=proc_provider()
    daemon=pv.get('daemon_idle',{}).get(sid) if isinstance(pv.get('daemon_idle'),dict) else daemon_idle_after_inject(sid[:8])
    term=pv.get('cli_terminal',{}).get(sid) if isinstance(pv.get('cli_terminal'),dict) else cli_terminal(sid)
    if daemon is not True or term is not True: return False,'executor turn lacks both daemon-idle and CLI-terminal proof'
    ok,why=nobody_working(chat)
    return ok,dict(session_id=sid,daemon_idle=daemon,cli_terminal=term,other_workers=why)

def active(chat):
    ROOT,TASK=delegation_identity()
    s=read_state(chat)
    if not managed_state(s)[0] or s.get('chat_id')!=chat: raise ValueError('node is not exactly managed')
    b=task_binding(s,TASK) or {}
    if b.get('root_request_id')!=ROOT or b.get('acceptance_status')!='accepted':
        raise ValueError('active task version lacks real accepted binding')
    cursor=chat; seen=set()
    while cursor:
        if cursor in seen: raise ValueError('ancestor cycle')
        seen.add(cursor); st=read_state(cursor)
        if not st or lifecycle_of(st)['status']!='active': raise ValueError('node or ancestor paused/finished/unmanaged')
        if cursor!=chat and not registered_descendant(chat,cursor): raise ValueError('ancestor registration differs')
        if task_control_for(st,TASK,chat).get('state')=='paused': raise ValueError('effective task pause')
        cursor=st.get('parent')
    d=s.get('delegation') or {}; own=csha([ROOT,TASK,chat]); v=b['task_version']
    view=(d.get('version_tasks') or {}).get(str(v),{}) if b.get('migration_id') else d.get('tasks',{})
    if view.get(own,{}).get('state') in ('paused','completed','cancelled','terminated','void'):
        raise ValueError('active version business branch is paused/terminal')
    return s,b

def already(s,child,version):
    ROOT,TASK=delegation_identity()
    return [x for x in lifecycle_of(s)['decisions']['out'] if x.get('to')==child and x.get('task_id')==TASK
        and (x.get('chain') or {}).get('root_request_id')==ROOT and (x.get('chain') or {}).get('task_version')==version]

def projection(chat,child):
    # Pin the same authorization surfaces as dispatch, not observer log mtimes.
    states={}; cursor=chat
    while cursor and cursor not in states:
        s=read_state(cursor); states[cursor]=auth_projection(s); cursor=(s or {}).get('parent')
    states[child]=auth_projection(read_state(child))
    return csha([states,sha256b(open(CONFIG_PATH,'rb').read()),
        sha256b(open(p_taskbook(chat),'rb').read()),read_jsonl(p_tbindex())])

def make_plan(chat,child,b,basis,guard_epoch):
    ROOT,TASK=delegation_identity()
    p=dict(root_request_id=ROOT,task_id=TASK,task_version=b['task_version'],chat_id=chat,
        target_child=child,executor_app=executor_app(chat),executor_ou=D.child_executor(read_state(chat))[0],
        delivery_message_id=b['delivery_message_id'],accepted_message_id=b['accepted_message_id'],
        next_action='standard_chain_dispatch',basis=basis)
    p['continuation_id']=csha(p); p['guard_epoch']=guard_epoch
    return p

def scan(chat):
    ROOT,TASK=delegation_identity()
    s,b=active(chat); ok,proof=idle(chat)
    if not ok: return dict(status='wait',reason=proof,candidates=[],whole_task_complete=False)
    # Do not read the entire chat merely to rediscover an already committed edge.
    nodes=taskbook_nodes(chat)
    if not nodes: raise ValueError('no structured taskbook next-action evidence')
    children={short(c):c for c in s.get('children',[])}; edges=[]
    for node,nd in nodes.items():
        if nd.get('status') in ('void','cancelled','paused'): continue
        for short_child,task in D.edge_targets(nd):
            if task!=TASK: continue
            child=children.get(short_child)
            if not child: raise ValueError('taskbook next is not a registered child')
            if already(s,child,b['task_version']): continue  # cancelled also needs explicit new plan, not blind retry
            edges.append((node,child))
    if not edges: return dict(status='no_action',reason='no unexecuted explicit edge',candidates=[],whole_task_complete=False)
    epoch={c:projection(chat,c) for _,c in edges}
    msgs=list_messages(chat,start=now()-datetime.timedelta(hours=48)); tb=taskbook_status(chat,msgs)
    if not tb.get('valid'): raise ValueError('taskbook invalid: '+str(tb.get('reason')))
    accepted=next((m for m in msgs if m['message_id']==b['accepted_message_id']),None)
    if not accepted: raise ValueError('current version acceptance source not readable')
    aq=quoted_message(accepted); accepted['_quoted_create_time_ms']=aq['createTime']
    if aq.get('senderType')!='app' or aq.get('senderId')!=executor_app(chat): raise ValueError('acceptance executor identity differs')
    candidates=[]; errors=[]
    for node,child in sorted(set(edges)):
        chain=dict(root_request_id=ROOT,task_id=TASK,task_version=b['task_version'],parent_delivery_id=b['delivery_message_id'])
        error=task_chain_guard(chat,child,TASK,chain)
        if error: errors.append(error); continue
        cs=read_state(child)
        if not managed_state(cs)[0] or cs.get('parent')!=chat or lifecycle_of(cs)['status']!='active' or not D.child_executor(cs)[0]:
            errors.append('child topology/status/executor invalid'); continue
        hits=[]
        expected_role='review' if nodes[node].get('kind')=='review' else 'worker'
        for m in msgs:
            if m.get('sender',{}).get('sender_type')!='app' or m['sender']['id']!=role_apps_for(s).get(expected_role): continue
            text=taskbook_message_text(m); marks=find_markers(text)
            for k in marks:
                if k.get('node')==node and k.get('role')==expected_role:
                    hits.append((m,k))
        if not hits: errors.append('no real prerequisite delivery/review for '+node); continue
        # Newest evidence governs; never bypass a newer NOT PASS with older PASS.
        m,k=max(hits,key=lambda x:(msg_time(x[0]),-msgs.index(x[0])))
        basis=dict(k,kind='bot_message',ref=m['message_id'],taskbook_sha=tb['sha'],taskbook_gen=tb['gen'])
        try:
            checked=D.validate_basis(chat,child,basis,TASK)
            if not msg_later(m,accepted,msgs): raise ValueError('prerequisite predates active-version real acceptance')
            if projection(chat,child)!=epoch[child]: raise ValueError('authority drift during observation')
            p=make_plan(chat,child,b,basis,epoch[child]); old=latest(chat,p['continuation_id'])
            p['observation_phase']=old['phase'] if old else 'unclaimed'; p['idle_proof']=proof
            p['basis_readback']=checked; candidates.append(p)
        except Exception as e: errors.append(str(e))
    return dict(status='ready' if candidates else 'blocked',candidates=candidates,errors=errors,whole_task_complete=False)

def trigger_text(p):
    body={k:p[k] for k in ('continuation_id','root_request_id','task_id','task_version','next_action','target_child','delivery_message_id','accepted_message_id')}
    return (encode_marker({'predecision_trigger':body})+'\n继续原任务的下一合法动作；不是新派单或新接单授权。'
        +'\n原依据='+p['basis']['ref']+'；taskbook_sha='+p['basis']['taskbook_sha']+'；gen='+str(p['basis']['taskbook_gen'])
        +'\n必须重走原 dispatch-task.sh --p5-chain 校验；依据失效则回报原错，不换 basis、不手填 binding。'
        +'\n先回复 predecision_response 封套（同 continuation_id/root/task/version，另含 trigger_message_id），'
        +'再提交标准动作结果或 predecision_failure（含 command/rc/error）；不把本项完成称整体完成。')

def reserve(chat,cid,sid,app):
    who=observer_identity(chat,sid,app)
    with ChatLock(chat):
        prior=latest(chat,cid)
        if prior: return dict(status='duplicate',phase=prior['phase'],send_allowed=False)
    data=scan(chat); p=next((p for p in data['candidates'] if p['continuation_id']==cid),None)
    if not p: raise ValueError('candidate is no longer actionable: '+canonical(data))
    with AuthLocks(chat,p['target_child']):
        if latest(chat,cid): return dict(status='duplicate',send_allowed=False)
        active(chat); ok,why=idle(chat)
        if not ok or projection(chat,p['target_child'])!=p['guard_epoch'] or already(read_state(chat),p['target_child'],p['task_version']):
            raise ValueError('candidate changed before observer route: '+str(why))
        if observer_identity(chat,sid,app)!=who: raise ValueError('observer identity drift')
        p=copy.deepcopy(p); p.pop('observation_phase',None)
        rec=record(chat,p,'reserved',observer=who)
    return dict(status='reserved',send_allowed=True,once_only=True,reserved_at=rec['at'],
        continuation_id=cid,chat_id=chat,executor_app=p['executor_app'],executor_ou=p['executor_ou'],text=trigger_text(p))

def fresh(m):
    q=quoted_message(m,raw=True); raw=q.get('rawContent')
    if q.get('msgType')!='text' or m.get('msg_type')!='text': raise ValueError('receipt requires original text envelope')
    obj=json.loads(raw) if isinstance(raw,str) else raw
    if not isinstance(obj,dict) or not isinstance(obj.get('text'),str): raise ValueError('receipt raw text missing')
    m['_quoted_create_time_ms']=q['createTime']; return obj['text']

def reconcile(chat,cid,sid,app):
    observer_identity(chat,sid,app); prev=latest(chat,cid)
    if not prev: raise ValueError('unknown continuation')
    p=prev['plan']; first=history(chat,cid)[0]
    msgs=list_messages(chat,start=datetime.datetime.strptime(first['at'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)-datetime.timedelta(seconds=1))
    triggers=[]; replies=[]; failures=[]
    for m in msgs:
        s=m.get('sender') or {}; text=fresh(m) if m.get('msg_type')=='text' else ''
        for mk in find_markers(text):
            if 'predecision_trigger' in mk and mk['predecision_trigger'].get('continuation_id')==cid:
                owner=owner_id_for_app(m.get('_reader_app_id')); ms=m.get('mentions') or []
                expected=find_markers(trigger_text(p))[0]
                if s.get('sender_type')!='user' or s.get('id')!=owner or len(ms)!=1 or ms[0].get('id') not in (p['executor_ou'],p['executor_app']):
                    raise ValueError('trigger owner/unique exact executor mention differs')
                rest=D.consume_mention_prefix(text,ms[0],p['executor_ou'])
                if len(MARK_RE.findall(text))!=1 or mk!=expected or rest is None or rest.lstrip(' \t')!=trigger_text(p):
                    raise ValueError('trigger envelope differs')
                if msg_time(m)<datetime.datetime.strptime(first['at'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ): raise ValueError('trigger predates reservation')
                triggers.append(m)
            for name,bag in [('predecision_response',replies),('predecision_failure',failures)]:
                body=mk.get(name)
                if not isinstance(body,dict) or body.get('continuation_id')!=cid: continue
                if s.get('sender_type')!='app' or s.get('id')!=p['executor_app'] or len(MARK_RE.findall(text))!=1:
                    raise ValueError('response is not unique real executor evidence')
                if any(body.get(k)!=p[k] for k in ('root_request_id','task_id','task_version')): raise ValueError('response task identity differs')
                bag.append((m,body))
    if len(triggers)>1: raise ValueError('duplicate observer trigger messages')
    if not triggers: return dict(status='unconfirmed',send_allowed=False,reason='no verified trigger; never blindly resend')
    trigger=triggers[0]; phase='sent_unconfirmed'; details={'trigger_message_id':trigger['message_id']}
    for m,body in replies+failures:
        if body.get('trigger_message_id')!=trigger['message_id'] or not msg_later(m,trigger,msgs): raise ValueError('response precedes or differs from trigger')
    if replies: phase='responded'; details['response_message_id']=replies[0][0]['message_id']
    if failures:
        m,body=failures[-1]
        if not replies or not body.get('error') or not isinstance(body.get('command'),list) or type(body.get('rc')) is not int or body['rc']==0:
            raise ValueError('failure lacks executor response/command/nonzero rc/error')
        phase='blocked'; details.update(failure_message_id=m['message_id'],error=body['error'])
    decisions=already(read_state(chat),p['target_child'],p['task_version'])
    if decisions and replies:
        if len(decisions)!=1: raise ValueError('multiple standard actions')
        e=decisions[0]
        if e.get('basis',{}).get('ref')!=p['basis']['ref'] or e.get('chain',{}).get('parent_delivery_id')!=p['delivery_message_id']:
            raise ValueError('subsequent action has different basis/binding')
        D.load_payload(chat,e['decision_id'],e)  # exact committed payload guard; no mutation
        if not e.get('pending_at') or e['pending_at']<msg_time(replies[0][0]).strftime('%Y-%m-%d %H:%M:%S'):
            raise ValueError('action predates task response')
        phase='action_observed'; details.update(decision_id=e['decision_id'],decision_state=e['state'],delivery_message_id=e.get('sent_message_id'))
    with ChatLock(chat):
        current=latest(chat,cid)
        order={'reserved':0,'sent_unconfirmed':1,'responded':2,'blocked':3,'action_observed':3}
        if order[phase]<order[current['phase']]: raise ValueError('receipt state would regress')
        if current['phase']==phase and all(current.get(k)==v for k,v in details.items()): return dict(status='duplicate',phase=phase,send_allowed=False)
        rec=record(chat,p,phase,**details)
        if phase=='blocked': ledger_line(chat,'decision前续推受阻 '+cid+' '+str(details)+'；沿原父链汇报，不重复触发')
    return dict(status=phase,send_allowed=False,whole_task_complete=False,at=rec['at'],**details)

def main():
    ap=argparse.ArgumentParser(description=__doc__); ap.add_argument('operation',choices=['scan','reserve','reconcile'])
    ap.add_argument('chat'); ap.add_argument('continuation_id',nargs='?'); ap.add_argument('--reader-session'); ap.add_argument('--declared-app'); a=ap.parse_args()
    try:
        delegation_identity()  # Every operation requires an explicit configured task.
        r=scan(a.chat) if a.operation=='scan' else (reserve if a.operation=='reserve' else reconcile)(a.chat,a.continuation_id,a.reader_session,a.declared_app)
        print(json.dumps(r,ensure_ascii=False)); return 9 if r.get('status')=='blocked' else 0
    except (Exception,SystemExit) as e:
        print(json.dumps({'status':'blocked','error':str(e),'send_allowed':False,'whole_task_complete':False,
            'parent_chat':(read_state(a.chat) or {}).get('parent'),'required_action':'observer records error via existing state/ledger and parent report; no retry send'},ensure_ascii=False)); return 9
if __name__=='__main__': sys.exit(main())
