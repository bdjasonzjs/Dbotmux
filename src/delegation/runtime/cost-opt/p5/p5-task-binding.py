#!/usr/bin/env python3
"""Import an existing, verified task delivery into the P5 task-event layer.

No sending, creating, wake changes or acceptance synthesis. Both a committed
parent delivery record and its actual target/message/sender/mention/body are
required. Legacy records are preserved, not replayed as new assignments.
"""
import os,sys,json,datetime,re
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
def intake_root(chat,root,task,version,scope_mid):
    """Initial owner request is an intake, not a fabricated upstream delivery.

    The operator supplies the request and scope message explicitly. The task
    must be named in the owner request; no pre-existing task or accepted event
    is copied into a new installation.
    """
    version=int(version)
    if (root,task)!=delegation_identity() or version<1 or chat!=delegation_scope('version_migration')['allowed_path'][0]:
        raise RuntimeError('root intake differs from configured root/task/path or invalid version')
    st=read_state(chat)
    if not managed_state(st)[0] or st.get('chat_id')!=chat or st.get('parent'):
        raise RuntimeError('root intake requires exact managed root, no parent')
    msgs=list_messages(chat,start=now()-datetime.timedelta(hours=48))
    request=next((m for m in msgs if m.get('message_id')==root),None)
    scope=next((m for m in msgs if m.get('message_id')==scope_mid),None)
    if not request or not scope or any(m.get('chat_id')!=chat for m in (request,scope)):
        raise RuntimeError('root request/scope source missing from exact chat')
    owner=owner_id_for_app(request.get('_reader_app_id'))
    if not owner or request.get('sender',{}).get('sender_type')!='user' or request['sender'].get('id')!=owner:
        raise RuntimeError('root request not owner in actual reader view')
    rq=quoted_message(request); sq=quoted_message(scope)
    if not isinstance(rq.get('content'),str) or task not in rq['content']:
        raise RuntimeError('owner request must name the configured task')
    if scope_mid!=root and (not rq.get('rootId') or rq['rootId']!=sq.get('rootId') or msg_time(scope)>=msg_time(request)):
        raise RuntimeError('root confirmation not after scope in same source thread')
    if not isinstance(sq.get('content'),str) or not sq['content'].strip():
        raise RuntimeError('scope source body missing')
    anchor={'kind':'root_owner_request','request_message_id':root,'scope_message_id':scope_mid,
            'source_thread_id':rq.get('rootId') or root,'reader_app':request['_reader_app_id'],
            'owner_id':owner,'request_body_sha':sha256b(rq['content'].encode()),
            'scope_body_sha':sha256b(sq['content'].encode())}
    with ChatLock(chat):
        current=read_state(chat)
        if current.get('parent') or not managed_state(current)[0]: raise RuntimeError('root topology/managed status drift')
        d=current.setdefault('delegation',{'schema_version':1,'root_request_id':root,'tasks':{},'bindings':{}})
        if d.get('root_request_id')!=root: raise RuntimeError('different task trial enrolled')
        bindings=d.setdefault('bindings',{}); old=bindings.get(task)
        if old and (old.get('anchor')!=anchor or old.get('task_version')!=version): raise RuntimeError('immutable root intake conflict')
        if not old:
            bindings[task]={'root_request_id':root,'task_id':task,'task_version':version,
                'parent_chat':None,'child_chat':chat,'delivery_message_id':root,
                'delivery_kind':'initial_owner_request','delivery_at':request['create_time'],
                'verified_at':ts(),'anchor':anchor,'acceptance_status':'awaiting_real_acceptance'}
            write_state(chat,current)
    print(json.dumps({'bound':True,'dedup':bool(old),'binding':bindings[task]},ensure_ascii=False))
def delivery_record(parent,child,root,task,version,mid):
    pst=read_state(parent) or {}
    hits=[e for e in lifecycle_of(pst)['decisions']['out'] if e.get('to')==child and e.get('task_id')==task and e.get('sent_message_id')==mid and e.get('state') in ('sent','acked') and (e.get('chain') or {}).get('root_request_id')==root and e['chain'].get('task_version')==version]
    if len(hits)==1: return {'kind':'p5_decision','decision_id':hits[0]['decision_id'],'sha':csha(hits[0])}
    if hits: raise RuntimeError('duplicate parent delivery records')
    old=(pst.get('tasks') or {}).get(task) or {}
    if old.get('rootRequestId')==root and old.get('taskbook_version')==version and old.get('child_chat_id')==child and old.get('delivery_message_id')==mid:
        return {'kind':'legacy_parent_task','sha':csha({k:old.get(k) for k in ('rootRequestId','taskbook_version','child_chat_id','delivery_message_id')})}
    raise RuntimeError('parent has no exact committed task delivery record')
def bind(child,root,task,version,mid):
    version=int(version)
    if root!=delegation_identity()[0] or version<1: raise RuntimeError('outside task trial or invalid version')
    cs=read_state(child); ok,why=managed_state(cs)
    if not ok: raise RuntimeError('child not managed: '+why)
    parent=cs.get('parent'); ps=read_state(parent) if parent else None
    if not ps or child not in (ps.get('children') or []): raise RuntimeError('parent/child registration mismatch')
    anchor=delivery_record(parent,child,root,task,version,mid)
    msgs=list_messages(child,start=now()-datetime.timedelta(hours=48))
    m=next((x for x in msgs if x.get('message_id')==mid),None)
    if not m or m.get('chat_id')!=child: raise RuntimeError('delivery message missing or in wrong target chat')
    sender=m.get('sender',{}); owner=owner_id_for_app(m.get('_reader_app_id'))
    if not owner or sender.get('sender_type')!='user' or sender.get('id')!=owner:
        raise RuntimeError('delivery is not owner in the actual reader app view')
    exec_app=role_apps_for(cs).get('executor'); targets={cs.get('executor_ou'),exec_app}-{None}
    mentions=m.get('mentions') or []
    if len(mentions)!=1 or mentions[0].get('id') not in targets: raise RuntimeError('delivery not exactly mentioned registered executor')
    if m.get('msg_type') in ('interactive','post'):
        text=quoted_message(m).get('content') or ''
    else: text=msg_text(m)
    if root not in text or task not in text: raise RuntimeError('delivery body lacks root/task identifiers')
    if not re.search(r'(?:任务书版本|task_version|版本)\s*[=:：]?\s*`?'+str(version)+r'\b',text): raise RuntimeError('delivery body lacks exact task version')
    with AuthLocks(parent,child):
        cs=read_state(child); ps=read_state(parent)
        if cs.get('parent')!=parent or child not in ps.get('children',[]) or delivery_record(parent,child,root,task,version,mid)!=anchor:
            raise RuntimeError('delivery binding drift before commit')
        d=cs.setdefault('delegation',{'schema_version':1,'root_request_id':root,'tasks':{},'bindings':{}})
        if d.get('root_request_id')!=root: raise RuntimeError('different trial already enrolled')
        bindings=d.setdefault('bindings',{}); old=bindings.get(task)
        if old and (old.get('task_version')!=version or old.get('delivery_message_id')!=mid): raise RuntimeError('immutable binding conflict; versioned migration required')
        if not old:
            bindings[task]={'root_request_id':root,'task_id':task,'task_version':version,'parent_chat':parent,'child_chat':child,'delivery_message_id':mid,'delivery_at':m['create_time'],'verified_at':ts(),'anchor':anchor,'acceptance_status':'awaiting_real_acceptance'}
            write_state(child,cs)
    print(json.dumps({'bound':True,'dedup':bool(old),'binding':bindings[task]},ensure_ascii=False))
def enroll_relay(parent,child):
    with AuthLocks(parent,child):
        ps=read_state(parent); cs=read_state(child)
        if not managed_state(ps)[0] or not managed_state(cs)[0]: raise RuntimeError('both nodes must already be managed')
        if child not in ps.get('children',[]) or cs.get('parent')!=parent: raise RuntimeError('unregistered edge')
        if (cs.get('delegation') or {}).get('root_request_id')!=delegation_identity()[0]: raise RuntimeError('child not enrolled in task trial')
        old=ps.get('delegation')
        if old and old.get('root_request_id')!=delegation_identity()[0]: raise RuntimeError('different trial already enrolled')
        if not old:
            ps['delegation']={'schema_version':1,'root_request_id':delegation_identity()[0],'tasks':{},'bindings':{},'relay_enrolled_from':child,'enrolled_at':ts()}
            write_state(parent,ps)
    print(json.dumps({'enrolled':parent,'child':child,'root_request_id':delegation_identity()[0]},ensure_ascii=False))
if __name__=='__main__':
    try:
        if sys.argv[1:2]==['intake-root'] and len(sys.argv)==7: intake_root(*sys.argv[2:])
        elif sys.argv[1:2]==['bind'] and len(sys.argv)==7: bind(*sys.argv[2:])
        elif sys.argv[1:2]==['enroll-relay'] and len(sys.argv)==4: enroll_relay(*sys.argv[2:])
        else: raise RuntimeError('usage: bind <child> <root> <task> <version> <delivery_message_id> | enroll-relay <parent> <child>')
    except Exception as ex: print(json.dumps({'ok':False,'error':str(ex)},ensure_ascii=False)); raise SystemExit(9)
