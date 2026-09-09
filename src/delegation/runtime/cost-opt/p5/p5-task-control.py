#!/usr/bin/env python3
"""Scoped task pause, using the existing P5 bubbles.out and round-end path.

pause <chat> <root> <task> <task_version> <control_version> <owner_message_id>
pause-child <parent> <child> <root> <task> <task_version> <control_version>
            <executor_source_message_id> --reader-session <sid> --declared-app <app>
flush <parent>    Send only already-queued registered edges, with exact readback.
ingest <child>    Persist the pause, acknowledge local landing, then queue children.
resume <origin> <root> <task> <task_version> <control_version> <pause_id> <owner_mid>
       --reader-session <sid> --declared-app <app> [--target-child <child>]
       [--authorization-chat <registered_ancestor_or_origin>]
resume-source <origin> <task> <pause_id> --reader-session <sid> --declared-app <app>
              [--target-child <child>]  Print intent only; no send/control write.

No wake/schedule mutations. No resume through retries or old assignments.
"""
import os,sys,json,datetime,hashlib,re,fcntl,importlib.util,contextlib,io,argparse,copy
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
def scoped(chat):
    st=read_state(chat)
    if not managed_state(st)[0] or st.get('chat_id')!=chat: raise RuntimeError('not an exact managed node')
    if (st.get('delegation') or {}).get('root_request_id')!=delegation_identity()[0]: raise RuntimeError('outside enrolled task trial')
    return st
def body(m):
    if m.get('msg_type') not in ('interactive','post'): return msg_text(m)
    return quoted_message(m).get('content') or ''
def source_envelope(c):
    keys=('root_request_id','task_id','task_version','control_version','action','origin_chat')
    if c.get('scope')=='child': keys+=('scope','target_child','parent_delivery_message_id','child_delivery_message_id')
    if c.get('action')=='resume': keys+=('resumes_control_id','resumes_source_message_id','resume_task_version','authorization_chat')
    return {k:c[k] for k in keys}
def validate(c):
    if c.get('root_request_id')!=delegation_identity()[0] or c.get('action') not in ('pause','resume'): raise RuntimeError('control scope/action invalid')
    for k in ('task_version','control_version'):
        if type(c.get(k)) is not int or c[k]<1: raise RuntimeError('invalid '+k)
    for k in ('task_id','origin_chat','evidence_message_id','occurred_at'):
        if not isinstance(c.get(k),str) or not c[k]: raise RuntimeError('missing '+k)
    if c.get('scope') not in (None,'child'): raise RuntimeError('unknown control scope')
    if c.get('scope')=='child':
        for k in ('target_child','issuer_app','parent_delivery_message_id','child_delivery_message_id','source_body_sha'):
            if not isinstance(c.get(k),str) or not c[k]: raise RuntimeError('missing branch control '+k)
        if c['target_child']==c['origin_chat']: raise RuntimeError('branch control cannot target issuer itself')
    if c.get('action')=='resume':
        for k in ('resumes_control_id','resumes_source_message_id','issuer_app','source_body_sha','authorization_chat'):
            if not isinstance(c.get(k),str) or not c[k]: raise RuntimeError('missing recovery '+k)
        if type(c.get('resume_task_version')) is not int or c['resume_task_version']!=c['task_version']+1:
            raise RuntimeError('recovery requires the next task version')
        if not registered_descendant(c['origin_chat'],c['authorization_chat']): raise RuntimeError('recovery authorization is outside issuer ancestry')
        authority=c.get('release_authority') or {}
        if authority.get('kind') not in ('executor','owner') or not authority.get('subject') or authority.get('original_source_message_id')!=c['resumes_source_message_id'] or not authority.get('original_source_sha256'):
            raise RuntimeError('recovery lacks verified original-subject authority')
    x={k:v for k,v in c.items() if k!='control_id'}
    if c.get('control_id')!=csha(x): raise RuntimeError('control identity mismatch')
def bubble_key(c,target): return csha([c['control_id'],target])
def control_slot(st,c):
    d=st['delegation']
    if c.get('scope')=='child' and st['chat_id']==c['origin_chat']:
        return d.setdefault('branch_controls',{}),branch_control_key(c['task_id'],c['target_child'])
    return d.setdefault('controls',{}),c['task_id']
def check_scope(st,c):
    if c.get('scope')!='child': return
    if st['chat_id']==c['origin_chat']:
        cs=read_state(c['target_child']) or {}
        if c['target_child'] not in (st.get('children') or []) or cs.get('parent')!=st['chat_id']:
            raise RuntimeError('branch control target is not an exact direct child')
    elif not registered_descendant(st['chat_id'],c['target_child']):
        raise RuntimeError('node outside controlled child subtree')
def queue(st,c):
    check_scope(st,c)
    lc=lifecycle_of(st)
    targets=[c['target_child']] if c.get('scope')=='child' and st['chat_id']==c['origin_chat'] else st.get('children') or []
    for target in targets:
        cs=read_state(target)
        if not cs or cs.get('parent')!=st['chat_id']: raise RuntimeError('registered child topology mismatch')
        d=cs.get('delegation') or {}
        if d.get('root_request_id')!=c['root_request_id']: continue
        current=task_binding(st,c['task_id']) or {}
        if current.get('migration_id'):
            cb=task_binding(cs,c['task_id']) or {}
            if target not in current['version_plan']['path'] or cb.get('migration_id')!=current['migration_id'] or cb.get('task_version')!=c['task_version']:
                continue  # Never retag an unmigrated/paused old subtree as v4.
        # Do not pause a different task merely because it shares the group.
        owns=c['task_id'] in (d.get('bindings') or {}) or any(t.get('task_id')==c['task_id'] for t in (d.get('tasks') or {}).values())
        if not owns: continue
        bid=bubble_key(c,target)
        if any(b.get('kind')=='task_control' and b.get('bubble_id')==bid for b in lc['bubbles']['out']): continue
        lc['bubbles']['out'].append({'kind':'task_control','bubble_id':bid,'control':c,'target':target,'state':'pending','pending_at':ts()})
    st['lifecycle']=lc
def apply(st,c,source,mid):
    check_scope(st,c)
    d=st['delegation']; controls,key=control_slot(st,c); old=controls.get(key)
    binding=task_binding(st,c['task_id']) or {}
    if binding.get('migration_id') and binding['task_version']>c['task_version']: return False,'obsolete_task_version'
    if binding.get('migration_id') and binding['task_version']!=c['task_version']: return False,'unbound_task_version'
    if old:
        if old.get('control_id')==c['control_id']:
            if c.get('scope')=='child' and st['chat_id']==c['origin_chat']: return False,'duplicate'
            repaired=(ensure_release_receipt if c['action']=='resume' else ensure_pause_receipt)(st,c,source,mid)
            return repaired,'pause_receipt_repaired' if repaired else 'duplicate'
        if c['task_version']<old['task_version'] or (c['task_version']==old['task_version'] and c['control_version']<=old['control_version']): return False,'stale_control'
        if old.get('action')=='resume' and c['control_version']!=old['control_version']+1:
            raise RuntimeError('post-recovery control requires exact next control version')
    if c['action']=='resume':
        recovery_predecessor(c,old)
        if binding.get('task_version')!=c['task_version']: raise RuntimeError('recovery requires exact paused binding')
    if binding.get('task_version',c['task_version'])>c['task_version']: return False,'obsolete_task_version'
    if old:
        history=d.setdefault('control_history',{})
        if old['control_id'] in history and history[old['control_id']]!=old: raise RuntimeError('immutable control history conflict')
        history[old['control_id']]=copy.deepcopy(old)
    controls[key]=dict(c,state='released' if c['action']=='resume' else 'paused',source_chat=source,source_message_id=mid,received_at=ts(),landed_at=ts())
    if c.get('scope')=='child' and st['chat_id']==c['origin_chat']:
        # This is an effective branch intent, not a pause of the issuer's own
        # task. Actual target state remains last-known until child ingest.
        queue(st,c)
        return True,'child_release_pending' if c['action']=='resume' else 'child_pause_pending'
    if c['action']=='resume':
        queue(st,c)
        ensure_release_receipt(st,c,source,mid)
        return True,'released_pending_new_version'
    rows=(d.get('version_tasks') or {}).get(str(c['task_version']),{}) if binding.get('migration_id') else d.get('tasks',{})
    for t in rows.values():
        if t.get('root_request_id')==c['root_request_id'] and t.get('task_id')==c['task_id']:
            t['state_before_pause']=t.get('state'); t['state']='paused'; t['paused_by_control']=c['control_id']
    queue(st,c)
    ensure_pause_receipt(st,c,source,mid)
    return True,'paused'

def recovery_predecessor(c,old):
    if not old or old.get('action')!='pause' or old.get('state')!='paused': raise RuntimeError('no current pause to recover')
    keys=('root_request_id','task_id','task_version','origin_chat','scope','target_child')
    if any(c.get(k)!=old.get(k) for k in keys): raise RuntimeError('recovery must preserve original task/root/issuer/scope')
    if (c.get('resumes_control_id')!=old.get('control_id') or c.get('resumes_source_message_id')!=old.get('evidence_message_id')
            or c['control_version']!=old['control_version']+1): raise RuntimeError('recovery must bind pause source and exact next control version')
    if c.get('evidence_message_id')==old.get('evidence_message_id'): raise RuntimeError('pause source cannot authorize recovery')
    if old.get('scope')=='child' and any(c.get(k)!=old.get(k) for k in ('issuer_app','parent_delivery_message_id','child_delivery_message_id')):
        raise RuntimeError('recovery branch identity/delivery changed')

def recovery_nodes(origin,control):
    """Do not overtake a pause still in flight on the controlled branch."""
    nodes=[]
    def visit(chat):
        if chat in nodes: raise RuntimeError('recovery subtree cycle')
        st=scoped(chat); nodes.append(chat)
        slot,key=control_slot(st,control); current=slot.get(key) or {}
        if current.get('control_id')!=control['control_id'] or current.get('state')!='paused':
            raise RuntimeError('pause has not landed consistently before recovery: '+chat)
        binding=task_binding(st,control['task_id']) or {}
        if binding.get('task_version')!=control['task_version'] or binding.get('acceptance_status')!='accepted':
            raise RuntimeError('recovery subtree lacks accepted paused-version binding')
        targets=[control['target_child']] if control.get('scope')=='child' and chat==origin else st.get('children') or []
        for target in targets:
            cs=read_state(target) or {}; cb=task_binding(cs,control['task_id'])
            if not cb or cb.get('root_request_id')!=control['root_request_id']: continue
            if cs.get('parent')!=chat: raise RuntimeError('unregistered recovery subtree')
            receipts=[b for b in lifecycle_of(st)['bubbles']['out'] if b.get('kind')=='task_control' and b.get('target')==target and b.get('control',{}).get('control_id')==control['control_id']]
            if len(receipts)!=1 or receipts[0].get('state')!='sent' or not receipts[0].get('child_landed_at'):
                raise RuntimeError('pause delivery not landed before recovery: '+target)
            visit(target)
    visit(origin)
    return nodes

def bound_source(chat,mid,ident,start=None):
    """The list locates a message; the actual registry-bound reader proves it."""
    m=next((m for m in list_messages(chat,start=start or now()-datetime.timedelta(hours=48)) if m.get('message_id')==mid),None)
    if not m or m.get('chat_id')!=chat: raise RuntimeError('control source missing in exact chat')
    pr=subprocess.run([BOTMUX_BIN,'quoted',mid,'--session-id',ident['session_id']],capture_output=True,text=True,timeout=60,
        env=dict(os.environ,SESSION_DATA_DIR=ident['data_dir'],BOTMUX_LARK_APP_ID=ident['app_id']))
    if pr.returncode: raise RuntimeError('control source quoted failed rc='+str(pr.returncode))
    q=parse_json_tail(pr.stdout)
    if q.get('messageId')!=mid or not isinstance(q.get('content'),str) or not q.get('createTime'):
        raise RuntimeError('control source lacks exact readback')
    return q

def recovery_authority(origin,old,ident,path):
    # Re-read the original source, not just its declared origin. Legacy controls
    # without issuer metadata do not become bot authority by omission.
    pause_at=datetime.datetime.strptime(old['occurred_at'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)
    q=bound_source(origin,old['evidence_message_id'],ident,pause_at-datetime.timedelta(minutes=1))
    if datetime.datetime.fromtimestamp(int(q['createTime'])/1000,BJ).replace(microsecond=0)!=pause_at:
        raise RuntimeError('original pause source time changed')
    if find_markers(q['content'])!=[{'task_control_source':source_envelope(old)}]:
        raise RuntimeError('original pause source/control mismatch')
    if old.get('source_body_sha') and sha256b(q['content'].encode())!=old['source_body_sha']:
        raise RuntimeError('original pause source bytes changed')
    if old.get('scope')=='child':
        if old.get('issuer_app')!=ident['app_id'] or (q.get('senderType'),q.get('senderId'))!=('app',ident['app_id']):
            raise RuntimeError('another subject owns this branch pause')
        branch_authority(origin,old['target_child'],old['root_request_id'],old['task_id'],old['task_version'])
        authority={'kind':'executor','subject':ident['app_id']}
    else:
        owner=owner_id_for_app(ident['app_id'])
        if not owner or (q.get('senderType'),q.get('senderId'))!=('user',owner):
            raise RuntimeError('original owner pause is not verified in reader view')
        authority={'kind':'owner','subject':owner}
    target=old.get('target_child',origin)
    for chat in path:
        if not registered_descendant(target,chat): continue
        active=task_control_for(read_state(chat),old['task_id'],target)
        if active.get('state')=='paused' and active.get('control_id')!=old['control_id']:
            raise RuntimeError('another subject or ancestor pause remains effective')
    return dict(authority,original_source_message_id=old['evidence_message_id'],original_source_sha256=sha256b(q['content'].encode()))

def ensure_release_receipt(st,c,source,mid):
    # Release is a control checkpoint, NEVER old-version business resumption.
    # Actual work needs separately authorized migration and fresh acceptance.
    spec=importlib.util.spec_from_file_location('p5_task_event',os.path.join(os.path.dirname(__file__),'p5-task-event.py'))
    events=importlib.util.module_from_spec(spec); spec.loader.exec_module(events)
    d=st['delegation']; landed=d['controls'][c['task_id']]
    if any(landed.get(k)!=v for k,v in c.items()) or landed.get('source_chat')!=source or landed.get('source_message_id')!=mid:
        raise RuntimeError('release receipt lacks exact landing')
    prior=events.task_of(d,c['root_request_id'],c['task_id'],st['chat_id'],c['task_version']) or {}
    records=[e for e in prior.get('events',[]) if e.get('derived_from_control')==c['control_id']]
    if records:
        if len(records)!=1 or not records[0].get('applied') or not events.local_control_release(st,records[0]):
            raise RuntimeError('release receipt anchor mismatch')
        return events.queue_bubble(st,records[0])
    ever=max([int(prior.get('applied_event_version') or 0)]+[int(e['event_version']) for e in prior.get('events',[])])+1
    ev={'root_request_id':c['root_request_id'],'task_id':c['task_id'],'task_version':c['task_version'],
        'event_version':ever,'event_type':'pause_released','occurred_at':landed['landed_at'],
        'origin_chat':st['chat_id'],'evidence_message_id':mid,'derived_from_control':c['control_id'],
        'control_origin_chat':c['origin_chat'],'control_source_message_id':c['evidence_message_id'],
        'resumes_control_id':c['resumes_control_id']}
    ev['event_id']=events.event_id(c['root_request_id'],c['task_id'],c['task_version'],ever,st['chat_id'],'pause_released',mid)
    events.validate_event(ev)
    changed,applied,reason=events.apply_event(st,ev,ts(),source,mid)
    if not applied: raise RuntimeError('release receipt rejected: '+reason)
    events.queue_bubble(st,ev)
    return True

def resume(origin,root,task,tv,cv,pause_id,mid,reader_session,declared_app,target_child=None,authorization_chat=None):
    tv=int(tv); cv=int(cv); ident=caller_reader(origin,reader_session,declared_app)
    authorization_chat=authorization_chat or origin
    if not registered_descendant(origin,authorization_chat): raise RuntimeError('recovery authorization is outside issuer ancestry')
    if (task_binding(scoped(authorization_chat),task) or {}).get('root_request_id')!=root:
        raise RuntimeError('authorization ancestor has no same-task binding')
    st=scoped(origin); binding=task_binding(st,task) or {}
    dummy={'task_id':task,'origin_chat':origin}
    if target_child: dummy.update(scope='child',target_child=target_child)
    slot,key=control_slot(st,dummy); old=slot.get(key) or {}
    # Only the original issuing node can originate a release. An ancestor or a
    # receiver holding a propagated control cannot impersonate its issuer.
    if old.get('origin_chat')!=origin or old.get('control_id')!=pause_id or old.get('state')!='paused':
        # Idempotent retry is allowed only for the exact committed owner source.
        if old.get('action')=='resume' and old.get('resumes_control_id')==pause_id and old.get('evidence_message_id')==mid and old.get('control_version')==cv and old.get('task_version')==tv and old.get('origin_chat')==origin and old.get('root_request_id')==root and old.get('authorization_chat')==authorization_chat:
            print(json.dumps({'changed':False,'result':'duplicate','control_id':old['control_id']})); return
        raise RuntimeError('recovery requires original issuer/current pause')
    if root!=delegation_identity()[0] or binding.get('root_request_id')!=root or binding.get('task_version')!=tv or binding.get('acceptance_status')!='accepted':
        raise RuntimeError('recovery lacks accepted paused task/version binding')
    check_scope(st,old)
    path=[]; cursor=origin
    while cursor:
        if cursor in path: raise RuntimeError('ancestor cycle')
        path.append(cursor); s=scoped(cursor); parent=s.get('parent')
        if parent and cursor not in scoped(parent).get('children',[]): raise RuntimeError('unregistered recovery ancestor')
        cursor=parent
    for chat in recovery_nodes(origin,old):
        if chat not in path: path.append(chat)
    projections={ch:auth_projection(read_state(ch)) for ch in path}; config_hash=csha(load_config())
    authority=recovery_authority(origin,old,ident,path)
    if authority['kind']=='executor' and authorization_chat!=origin:
        raise RuntimeError('executor release must be sourced in its original issuing chat')
    c={k:old[k] for k in ('root_request_id','task_id','task_version','origin_chat')}
    if target_child:
        for k in ('scope','target_child','parent_delivery_message_id','child_delivery_message_id'): c[k]=old[k]
    c.update(action='resume',control_version=cv,evidence_message_id=mid,issuer_app=ident['app_id'],
             resumes_control_id=pause_id,resumes_source_message_id=old['evidence_message_id'],resume_task_version=tv+1,authorization_chat=authorization_chat)
    recovery_predecessor(c,old)
    m=next((m for m in list_messages(authorization_chat,start=now()-datetime.timedelta(hours=48)) if m.get('message_id')==mid),None)
    if not m or m.get('chat_id')!=authorization_chat: raise RuntimeError('recovery owner source missing in exact authorization chat')
    pr=subprocess.run([BOTMUX_BIN,'quoted',mid,'--session-id',reader_session],capture_output=True,text=True,timeout=60,
        env=dict(os.environ,SESSION_DATA_DIR=ident['data_dir'],BOTMUX_LARK_APP_ID=ident['app_id']))
    if pr.returncode: raise RuntimeError('recovery quoted failed rc='+str(pr.returncode))
    q=parse_json_tail(pr.stdout); owner=owner_id_for_app(ident['app_id'])
    # The list is only a chat/message locator; its open_id may be from the
    # configured Claude/observer view. It never supplies authorization. Compare
    # owner ONLY in the actual registry-bound quoted reader's app view.
    expected=('app',authority['subject']) if authority['kind']=='executor' else ('user',owner)
    if not expected[1] or q.get('messageId')!=mid or (q.get('senderType'),q.get('senderId'))!=expected:
        raise RuntimeError('recovery source is not the original control subject in bound reader view')
    at=datetime.datetime.fromtimestamp(int(q['createTime'])/1000,BJ)
    if not now()-datetime.timedelta(hours=48)<=at<=now()+datetime.timedelta(seconds=60) or at<datetime.datetime.strptime(old['occurred_at'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ):
        raise RuntimeError('stale/future recovery authorization')
    text=q.get('content')
    if not isinstance(text,str) or find_markers(text)!=[{'task_control_source':source_envelope(c)}]: raise RuntimeError('recovery owner envelope differs from exact scope/control')
    c.update(occurred_at=at.strftime('%Y-%m-%d %H:%M:%S'),source_body_sha=sha256b(text.encode()),release_authority=authority)
    c['control_id']=csha(c); validate(c)
    with AuthLocks(*path):
        if csha(load_config())!=config_hash or caller_reader(origin,reader_session,declared_app)!=ident or any(auth_projection(read_state(ch))!=p for ch,p in projections.items()):
            raise RuntimeError('recovery reader/authority drift')
        recovery_nodes(origin,old)
        st=scoped(origin); changed,why=apply(st,c,authorization_chat,mid)
        if changed:
            slot,key=control_slot(st,c); slot[key]['reader_proof']=ident
            write_state(origin,st)
    print(json.dumps({'changed':changed,'result':why,'control_id':c['control_id'],'business_resumed':False,'requires_new_task_version':tv+1}))

def recovery_alarm(chat,error=None):
    # Same node state/ledger, not a second notification queue. Invalid unknown
    # targets are never enrolled just to record an alarm.
    scoped(chat)
    with ChatLock(chat):
        st=scoped(chat); d=st['delegation']; old=d.get('guard_status') or {}
        state='blocked' if error else 'cleared'
        if not error and old.get('command')!='resume': return
        if (old.get('state'),old.get('error'))==(state,error): return
        entry={'state':state,'command':'resume','error':error,'at':ts(),'parent_chat':st.get('parent'),
               'root_request_id':delegation_identity()[0],'last_known_only':True,'business_state_changed':False}
        ledger_line(chat,'A3 恢复守卫 '+state+'（父执行者可查；不推进业务）：'+str(error or '本次显式恢复控制已处理'))
        d['guard_status']=entry; write_state(chat,st)

def resume_source(origin,task,pause_id,reader_session,declared_app,target_child=None):
    ident=caller_reader(origin,reader_session,declared_app); st=scoped(origin)
    dummy={'task_id':task,'origin_chat':origin}
    if target_child: dummy.update(scope='child',target_child=target_child)
    slot,key=control_slot(st,dummy); old=slot.get(key) or {}
    if old.get('control_id')!=pause_id or old.get('origin_chat')!=origin or old.get('action')!='pause' or old.get('state')!='paused':
        raise RuntimeError('no exact current original pause for recovery intent')
    if target_child and old.get('issuer_app')!=ident['app_id']: raise RuntimeError('original executor subject changed')
    c=dict(old,action='resume',control_version=old['control_version']+1,
        resumes_control_id=pause_id,resumes_source_message_id=old['evidence_message_id'],
        resume_task_version=old['task_version']+1,authorization_chat=origin)
    print(encode_marker({'task_control_source':source_envelope(c)}))

def ensure_pause_receipt(st,c,source,mid):
    # A local pause landing is itself a task milestone. Reuse the same event
    # ledger and outbox, including repair of the pre-fix self-rejected receipt.
    # Call only under the existing apply/ingest lock after exact control readback.
    d=st['delegation']
    landed=(d.get('controls') or {}).get(c['task_id']) or {}
    binding=task_binding(st,c['task_id']) or {}
    if (any(landed.get(k)!=v for k,v in c.items()) or landed.get('state')!='paused'
            or landed.get('source_chat')!=source or landed.get('source_message_id')!=mid
            or not landed.get('landed_at') or binding.get('task_version')!=c['task_version']):
        raise RuntimeError('pause receipt lacks exact current committed control/binding')
    spec=importlib.util.spec_from_file_location('p5_task_event',os.path.join(os.path.dirname(__file__),'p5-task-event.py'))
    events=importlib.util.module_from_spec(spec); spec.loader.exec_module(events)
    prior=events.task_of(d,c['root_request_id'],c['task_id'],st['chat_id'],c['task_version']) or {}
    records=[e for e in prior.get('events',[]) if e.get('derived_from_control')==c['control_id']]
    for e in records:
        if not events.local_control_pause(st,e): raise RuntimeError('committed pause receipt anchor mismatch')
    applied=[e for e in records if e.get('applied')]
    if len(applied)>1: raise RuntimeError('multiple applied receipts for one control')
    if any(e.get('downstream_rejections') or e.get('reject_reason')!='paused_no_reactivation'
           for e in records if not e.get('applied')):
        raise RuntimeError('control receipt rejection is not eligible for repair')
    changed=False
    # Preserve and forward the old rejection as audit, never rewrite its verdict.
    for e in records:
        changed=events.queue_bubble(st,e) or changed
    if applied: return changed
    if prior and (prior.get('state')!='paused' or prior.get('task_version')!=c['task_version']):
        raise RuntimeError('pause receipt repair cannot replace a different task state/version')
    ever=max([int(prior.get('applied_event_version') or 0)]+
        [int(e['event_version']) for e in prior.get('events',[]) if e.get('task_version')==c['task_version']])+1
    ev={'root_request_id':c['root_request_id'],'task_id':c['task_id'],
        'task_version':c['task_version'],'event_version':ever,'event_type':'paused',
        'occurred_at':landed['landed_at'],'origin_chat':st['chat_id'],'evidence_message_id':mid,
        'derived_from_control':c['control_id'],'control_origin_chat':c['origin_chat'],
        'control_source_message_id':c['evidence_message_id']}
    ev['event_id']=events.event_id(c['root_request_id'],c['task_id'],c['task_version'],ever,st['chat_id'],'paused',mid)
    events.validate_event(ev)
    changed,applied,reason=events.apply_event(st,ev,ts(),source,mid)
    if not applied: raise RuntimeError('committed control receipt rejected: '+reason)
    events.queue_bubble(st,ev)
    return True
def pause(chat,root,task,tv,cv,mid):
    st=scoped(chat); binding=task_binding(st,task)
    if root!=delegation_identity()[0] or not binding or binding.get('task_version')!=int(tv): raise RuntimeError('no exact bound task/version')
    m=next((m for m in list_messages(chat,start=now()-datetime.timedelta(hours=48)) if m.get('message_id')==mid),None)
    if not m or m.get('chat_id')!=chat: raise RuntimeError('owner source not in exact chat')
    s=m.get('sender',{}); owner=owner_id_for_app(m.get('_reader_app_id'))
    if not owner or s.get('sender_type')!='user' or s.get('id')!=owner: raise RuntimeError('source not owner in actual reader view')
    c={'root_request_id':root,'task_id':task,'task_version':int(tv),'control_version':int(cv),'action':'pause','origin_chat':chat,'evidence_message_id':mid,'occurred_at':msg_time(m).strftime('%Y-%m-%d %H:%M:%S')}
    if find_markers(body(m))!=[{'task_control_source':source_envelope(c)}]: raise RuntimeError('owner message lacks exact pause envelope')
    c['control_id']=csha(c); validate(c)
    with ChatLock(chat):
        st=scoped(chat)
        if task_binding(st,task)!=binding: raise RuntimeError('binding drift')
        changed,why=apply(st,c,chat,mid); write_state(chat,st)
    print(json.dumps({'changed':changed,'result':why,'control_id':c['control_id']}))

def caller_reader(parent,sid,declared):
    if not sid or not declared: raise RuntimeError('missing bound reader session/declared app')
    if os.environ.get('BOTMUX_LARK_APP_SECRET'): raise RuntimeError('env-only reader not allowed')
    path=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),'bin','verify-prod-spawn-authz.py')
    spec=importlib.util.spec_from_file_location('branch_gatea_reader',path); gate=importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
    directory=gate.data_dir(); output=io.StringIO()
    try:
        with contextlib.redirect_stdout(output): app,row,registry=gate.resolve_reader(sid,directory)
    except SystemExit: raise RuntimeError(output.getvalue().strip())
    ps=scoped(parent)
    if not ps.get('type') or not ps.get('executor_ou'): raise RuntimeError('parent executor role not registered')
    if not app or app!=declared or app!=executor_app(ps): raise RuntimeError('actual reader app is not declared parent executor')
    if row.get('status')!='active' or row.get('chatId')!=parent: raise RuntimeError('caller must be active parent-chat session')
    return {'session_id':sid,'app_id':app,'chat_id':parent,'data_dir':directory,'registry':registry}

def branch_authority(parent,child,root,task,tv):
    ps=scoped(parent); cs=scoped(child)
    if cs.get('parent')!=parent or child not in (ps.get('children') or []): raise RuntimeError('not an exact direct child')
    if root!=delegation_identity()[0]: raise RuntimeError('wrong branch root')
    path=[]; cursor=parent
    while cursor:
        if cursor in path: raise RuntimeError('ancestor cycle')
        path.append(cursor); st=scoped(cursor)
        if not st.get('type') or not st.get('executor_ou'): raise RuntimeError('ancestor role not registered: '+cursor)
        binding=task_binding(st,task) or {}
        if binding.get('root_request_id')!=root or binding.get('task_version')!=tv or not binding.get('delivery_message_id') or binding.get('acceptance_status')!='accepted':
            raise RuntimeError('ancestor lacks accepted task/version binding: '+cursor)
        up=st.get('parent')
        if up and cursor not in ((read_state(up) or {}).get('children') or []): raise RuntimeError('unregistered ancestor edge')
        cursor=up
    pb=task_binding(ps,task); cb=task_binding(cs,task) or {}
    if (cb.get('root_request_id'),cb.get('task_version'),cb.get('parent_chat'),cb.get('acceptance_status'))!=(root,tv,parent,'accepted') or not cb.get('delivery_message_id'):
        raise RuntimeError('target lacks exact accepted task delivery')
    return path,pb,cb

def pause_child(parent,child,root,task,tv,cv,mid,reader_session,declared_app):
    tv=int(tv); cv=int(cv); identity=caller_reader(parent,reader_session,declared_app)
    path,pb,cb=branch_authority(parent,child,root,task,tv)
    projections={chat:auth_projection(read_state(chat)) for chat in path+[child]}
    c={'root_request_id':root,'task_id':task,'task_version':tv,'control_version':cv,'action':'pause',
       'scope':'child','origin_chat':parent,'target_child':child,'evidence_message_id':mid,
       'parent_delivery_message_id':pb['delivery_message_id'],'child_delivery_message_id':cb['delivery_message_id'],
       'issuer_app':identity['app_id']}
    msgs=list_messages(parent,start=now()-datetime.timedelta(hours=48))
    m=next((m for m in msgs if m.get('message_id')==mid),None)
    if not m or m.get('chat_id')!=parent or m.get('sender',{}).get('sender_type')!='app' or m['sender']['id']!=identity['app_id']:
        raise RuntimeError('branch intent source is not actual parent executor in parent chat')
    pr=subprocess.run([BOTMUX_BIN,'quoted',mid,'--session-id',reader_session],capture_output=True,text=True,timeout=60,
                      env=dict(os.environ,SESSION_DATA_DIR=identity['data_dir'],BOTMUX_LARK_APP_ID=identity['app_id']))
    if pr.returncode: raise RuntimeError('branch intent quoted failed rc='+str(pr.returncode))
    q=parse_json_tail(pr.stdout)
    if q.get('messageId')!=mid or q.get('senderId')!=identity['app_id'] or q.get('senderType')!='app': raise RuntimeError('branch intent quoted identity mismatch')
    text=q.get('content')
    if not isinstance(text,str) or find_markers(text)!=[{'task_control_source':source_envelope(c)}]: raise RuntimeError('branch intent lacks exact control source envelope')
    c['occurred_at']=(datetime.datetime.fromtimestamp(int(q['createTime'])/1000,BJ).strftime('%Y-%m-%d %H:%M:%S') if q.get('createTime') else msg_time(m).strftime('%Y-%m-%d %H:%M:%S'))
    c['source_body_sha']=sha256b(text.encode()); c['control_id']=csha(c); validate(c)
    with AuthLocks(*(path+[child])):
        if caller_reader(parent,reader_session,declared_app)!=identity: raise RuntimeError('caller reader changed during source verification')
        current_path,current_pb,current_cb=branch_authority(parent,child,root,task,tv)
        if current_path!=path or any(auth_projection(read_state(ch))!=p for ch,p in projections.items()): raise RuntimeError('branch authority changed during source verification')
        ps=scoped(parent); old=ps['delegation'].get('branch_controls',{}).get(branch_control_key(task,child)) or {}
        if old.get('control_id')!=c['control_id']:
            tightening_release=(old.get('action')=='resume' and old.get('state')=='released'
                and old.get('task_version')==tv and old.get('control_version',-2)+1==cv)
            if not tightening_release:
                why=task_chain_guard(parent,child,task,{'root_request_id':root,'task_id':task,'task_version':tv,'parent_delivery_id':pb['delivery_message_id']})
                if why: raise RuntimeError('branch control guard: '+why)
        changed,why=apply(ps,c,parent,mid)
        if changed:
            ps['delegation']['branch_controls'][branch_control_key(task,child)]['reader_proof']=identity
        write_state(parent,ps)
    print(json.dumps({'changed':changed,'result':why,'control_id':c['control_id'],'reader_proof':identity}))
def wire(c,parent,child,executor):
    return f'<at user_id="{executor}">执行者</at> '+encode_marker({'task_control':c['control_id'],'source_chat':parent,'target_chat':child})+' '+canonical(c)
def exact(m,c,parent,child,executor):
    s=m.get('sender',{}); owner=owner_id_for_app(m.get('_reader_app_id'))
    if not owner or s.get('sender_type')!='user' or s.get('id')!=owner or m.get('chat_id')!=child: return False
    mentions=m.get('mentions') or []
    if len(mentions)!=1 or mentions[0].get('id') not in {executor,executor_app(read_state(child))}: return False
    text=body(m); rest=None
    for prefix in (f'<at user_id="{executor}">',mentions[0].get('key'),('@'+mentions[0]['name']) if mentions[0].get('name') else None):
        if prefix and text.startswith(prefix):
            rest=text[text.index('</at>')+5:] if prefix.startswith('<at ') and '</at>' in text else text[len(prefix):]; break
    expected=wire(c,parent,child,executor).split('</at>',1)[1]
    return rest==expected
def automatic_scope(c,scope):
    return c.get('root_request_id')==scope['root_request_id'] and c.get('task_id')==scope['task_id'] and c.get('origin_chat') in scope['allowed_path']
def flush(parent,scope=None):
    st=scoped(parent); results=[]; ob=p_outbox(parent); os.makedirs(ob,exist_ok=True)
    for pending in lifecycle_of(st)['bubbles']['out']:
        if pending.get('kind')!='task_control' or pending.get('state') not in ('pending','sending'): continue
        if scope and (pending.get('target') not in scope['allowed_path'] or not automatic_scope(pending.get('control',{}),scope)): continue
        bid=pending['bubble_id']; c=pending['control']; target=pending['target']; validate(c)
        fd=os.open(os.path.join(ob,'control-'+bid+'.lock'),os.O_RDWR|os.O_CREAT,0o644); fcntl.flock(fd,fcntl.LOCK_EX)
        try:
            with AuthLocks(parent,target):
                ps=scoped(parent); cs=scoped(target)
                if cs.get('parent')!=parent or target not in ps.get('children',[]): raise RuntimeError('foreign subtree/topology drift')
                check_scope(ps,c)
                if c.get('scope')=='child' and ps['chat_id']==c['origin_chat'] and target!=c['target_child']: raise RuntimeError('branch bubble targets wrong child')
                slot,key=control_slot(ps,c); ctrl=slot.get(key) or {}
                lc=lifecycle_of(ps); live=next(b for b in lc['bubbles']['out'] if b.get('bubble_id')==bid)
                if ctrl.get('control_id')!=c['control_id']:
                    # A newer PAUSE may fence a release that is still pending
                    # or had an unknown send outcome. Keep its full record and
                    # uncertainty, but never resend the superseded release or
                    # let it block delivery of the safer current pause.
                    if c['action']=='resume' and ctrl.get('action')=='pause' and ctrl.get('control_version',0)>c['control_version']:
                        live.update(previous_state=live['state'],outcome_unknown=live['state']=='sending',
                            state='superseded',superseded_by=ctrl['control_id'],superseded_at=ts())
                        ps['lifecycle']=lc; write_state(parent,ps); continue
                    raise RuntimeError('source control no longer current')
                if live['state']=='sent': continue
                executor=cs.get('executor_ou')
                if not executor: raise RuntimeError('missing target executor')
                since=datetime.datetime.strptime(live['pending_at'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)-datetime.timedelta(minutes=10)
                matches=[m for m in list_messages(target,start=since) if exact(m,c,parent,target,executor)]
                if matches: mid=min(matches,key=msg_time)['message_id']
                else:
                    live['state']='sending'; live['sending_at']=ts(); ps['lifecycle']=lc; write_state(parent,ps)
                    mid=send_message(target,wire(c,parent,target,executor),as_user=True,idempotency_key=bid[:32])
                    actual=next((m for m in list_messages(target,start=since) if m.get('message_id')==mid),None)
                    if not actual or not exact(actual,c,parent,target,executor): raise RuntimeError('sent control not verified at exact target/executor')
                live['state']='sent'; live['sent_message_id']=mid; live['sent_at']=ts(); live.pop('sync_error',None); ps['lifecycle']=lc; write_state(parent,ps)
                results.append({'control_id':c['control_id'],'target':target,'message_id':mid})
        except Exception as e:
            with ChatLock(parent):
                ps=scoped(parent); lc=lifecycle_of(ps)
                for b in lc['bubbles']['out']:
                    if b.get('bubble_id')==bid: b['sync_error']=str(e); b['last_error_at']=ts()
                ps['lifecycle']=lc; write_state(parent,ps)
            raise
        finally: fcntl.flock(fd,fcntl.LOCK_UN); os.close(fd)
    print(json.dumps({'flushed':results}))
def ingest(child,scope=None):
    cs=scoped(child); parent=cs.get('parent'); results=[]
    if not parent: print(json.dumps({'ingested':[]})); return
    if scope and parent not in scope['allowed_path']: raise RuntimeError('control parent outside automatic scope')
    ps=scoped(parent)
    if child not in ps.get('children',[]): raise RuntimeError('unregistered edge')
    sent=[b for b in lifecycle_of(ps)['bubbles']['out'] if b.get('kind')=='task_control' and b.get('target')==child and b.get('state')=='sent' and (not scope or automatic_scope(b.get('control',{}),scope))]
    receipt_ids={b.get('sent_message_id') for b in sent}
    since=now()-datetime.timedelta(hours=48)
    for b in sent:
        if not b.get('child_landed_at'):
            since=min(since,datetime.datetime.strptime(b['pending_at'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)-datetime.timedelta(minutes=10))
    for m in list_messages(child,start=since):
        if m.get('msg_type') in ('interactive','post') and m.get('message_id') not in receipt_ids: continue
        for marker in find_markers(body(m)):
            if not marker.get('task_control'): continue
            candidates=[b for b in sent if b.get('sent_message_id')==m['message_id'] and b.get('control',{}).get('control_id')==marker['task_control']]
            if len(candidates)!=1: results.append({'message_id':m['message_id'],'result':'unresolved_receipt'}); continue
            b=candidates[0]; c=b['control']; validate(c)
            if not exact(m,c,parent,child,cs.get('executor_ou')): results.append({'message_id':m['message_id'],'result':'reject_exact_target'}); continue
            with AuthLocks(parent,child):
                ps=scoped(parent); cs=scoped(child)
                if cs.get('parent')!=parent or child not in ps.get('children',[]): raise RuntimeError('topology changed before landing')
                changed,why=apply(cs,c,parent,m['message_id']); write_state(child,cs)
                current=cs['delegation']['controls'].get(c['task_id']) or {}
                recorded=current if current.get('control_id')==c['control_id'] else (cs['delegation'].get('control_history') or {}).get(c['control_id'],{})
                landed=recorded.get('landed_at')
                lc=lifecycle_of(ps)
                for q in lc['bubbles']['out']:
                    if q.get('bubble_id')==b['bubble_id'] and landed and not q.get('child_landed_at'):
                        q['child_landed_at']=landed; q['child_result']=why
                ps['lifecycle']=lc; write_state(parent,ps)
            results.append({'message_id':m['message_id'],'result':why,'changed':changed,'landed_at':landed})
    print(json.dumps({'ingested':results}))
if __name__=='__main__':
    try:
        if sys.argv[1]=='resume-source':
            parser=argparse.ArgumentParser()
            for field in ('origin','task','pause_id'): parser.add_argument(field)
            parser.add_argument('--reader-session',required=True); parser.add_argument('--declared-app',required=True)
            parser.add_argument('--target-child'); resume_source(**vars(parser.parse_args(sys.argv[2:])))
        elif sys.argv[1]=='resume':
            parser=argparse.ArgumentParser()
            for field in ('origin','root','task','tv','cv','pause_id','mid'): parser.add_argument(field)
            parser.add_argument('--reader-session',required=True); parser.add_argument('--declared-app',required=True)
            parser.add_argument('--target-child')
            parser.add_argument('--authorization-chat')
            resume(**vars(parser.parse_args(sys.argv[2:])))
            recovery_alarm(sys.argv[2])
        elif sys.argv[1]=='pause-child':
            parser=argparse.ArgumentParser()
            for field in ('parent','child','root','task','tv','cv','mid'): parser.add_argument(field)
            parser.add_argument('--reader-session',required=True); parser.add_argument('--declared-app',required=True)
            args=parser.parse_args(sys.argv[2:]); pause_child(**vars(args))
        else: {'pause':pause,'flush':flush,'ingest':ingest}[sys.argv[1]](*sys.argv[2:])
    except Exception as e:
        if sys.argv[1:2]==['resume'] and len(sys.argv)>2:
            try: recovery_alarm(sys.argv[2],str(e))
            except Exception as alarm: print(json.dumps({'alarm_error':str(alarm)},ensure_ascii=False))
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False)); raise SystemExit(9)
