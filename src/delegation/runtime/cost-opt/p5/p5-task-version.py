#!/usr/bin/env python3
"""Explicit task-version entry; disabled unless a separately scoped gate is enabled.

plan <plan.json> prints the canonical owner approval envelope (no writes).
prepare-root <chat> <plan.json> <owner_source_mid> <reader_session> <app>
prepare-delegated <chat> <plan.json> <executor_proposal_mid> <review_mid> <reader_session> <app>
proposal <plan.json>  /  review-source <plan.json> <executor_proposal_mid>
bind-next <child> <task> <new_delivery_mid>
renewal-plan <root> <new-plan.json> / renewal-proposal <request.json>
renewal-review-source <request.json> <proposal_mid>
renew-approval <root> <request.json> <proposal_mid> <review_mid> <session> <app>
renewal-recover <root> <renewal_id> <session> <app>

This does not dispatch, accept, resume, create groups or enable automation.
New dispatches still use dispatch-task.sh --p5-chain; new acceptances still use
p5-task-event.py emit. Old bindings, payloads, events and controls remain intact.
"""
import copy, importlib.util, pathlib, sys, os, json, datetime
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
def migration_scope(): return delegation_scope('version_migration')
def module(name):
    spec=importlib.util.spec_from_file_location(name,pathlib.Path(__file__).with_name(name+'.py'))
    mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
def validate_plan(p):
    if not isinstance(p,dict) or set(p)!={'root_request_id','task_id','from_version','to_version','change_evidence_ids','documents','path','expires_at'}:
        raise RuntimeError('exact version plan fields required')
    scope=migration_scope()
    if (p['root_request_id'],p['task_id'])!=(scope['root_request_id'],scope['task_id']): raise RuntimeError('outside assigned task trial')
    if type(p['from_version']) is not int or p['from_version']<3 or type(p['to_version']) is not int or p['to_version']!=p['from_version']+1:
        raise RuntimeError('only explicit next version allowed')
    for key,prefix in [('path','oc_'),('change_evidence_ids','om_')]:
        xs=p[key]
        if not isinstance(xs,list) or not xs or len(xs)!=len(set(xs)) or any(not isinstance(x,str) or not re.fullmatch(prefix+'[A-Za-z0-9]+',x) for x in xs):
            raise RuntimeError('invalid '+key)
    if len(p['path'])<2: raise RuntimeError('version path needs registered parent/child edge')
    docs=p['documents']
    if not isinstance(docs,list) or not docs: raise RuntimeError('complete task documents required')
    names=set()
    for doc in docs:
        if not isinstance(doc,dict) or set(doc)!={'name','sha256','content'} or not isinstance(doc['name'],str) or doc['name'] in names:
            raise RuntimeError('invalid/duplicate document')
        if not isinstance(doc['content'],str) or not doc['content'].strip() or sha256b(doc['content'].encode())!=doc['sha256']:
            raise RuntimeError('full document bytes/SHA mismatch')
        names.add(doc['name'])
    if not {'kickoff.md','kickoff-v4-increment.md'}<=names: raise RuntimeError('original and increment must both be inherited')
    expiry=datetime.datetime.strptime(p['expires_at'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)
    if not now()<expiry<=now()+datetime.timedelta(days=7): raise RuntimeError('expired or overlong migration approval')
    return p
def gated(p):
    g=migration_scope()
    if g.get('enabled') is not True or g.get('root_request_id')!=p.get('root_request_id') or g.get('task_id')!=p.get('task_id') or g.get('allowed_path')!=p['path']:
        raise RuntimeError('version migration disabled or outside separately enabled scope')
def envelope(p): return {'task_version_source':{'migration_id':csha(p),'plan':p}}
def proposal_envelope(p):
    return {'task_version_proposal':{'migration_id':csha(p),'plan':p,
        'mandate_message_id':migration_scope()['root_request_id'],'authority':'existing_task_engineering','operation':'task_version_migration'}}
def review_envelope(p,proposal):
    return {'task_version_review':{'migration_id':csha(p),'proposal_message_id':proposal,
        'mandate_message_id':migration_scope()['root_request_id'],'verdict':'PASS','authority':'existing_task_engineering',
        'operation':'task_version_migration','runtime_enable':False}}
def read_plan(file): return validate_plan(json.loads(pathlib.Path(file).read_text()))
def topology(p):
    path=p['path']
    for i,chat in enumerate(path):
        st=read_state(chat)
        if not st or st.get('chat_id')!=chat or not managed_state(st)[0]: raise RuntimeError('missing exact managed node')
        if st.get('parent')!=(path[i-1] if i else None): raise RuntimeError('version path is not exact root/parent chain')
        if i and chat not in read_state(path[i-1]).get('children',[]): raise RuntimeError('unregistered version edge')
    return path
def not_paused(p,chat):
    # Upgrade is not resume, including when a control has not reached its child.
    for ancestor in p['path'][:p['path'].index(chat)+1]:
        st=read_state(ancestor)
        if task_control_for(st,migration_scope()['task_id'],chat).get('state')=='paused': raise RuntimeError('paused version scope cannot be upgraded')
    st=read_state(chat)
    if st.get('paused') or lifecycle_of(st).get('status') in ('paused','finished'): raise RuntimeError('node is not active')
    d=st.get('delegation') or {}
    for t in d.get('tasks',{}).values():
        if t.get('task_id')==migration_scope()['task_id'] and t.get('origin_chat')==chat and t.get('state')=='paused': raise RuntimeError('own task remains paused')
def predecessors(p, migration_id=None):
    expected=csha(p)
    if migration_id is not None:
        root_binding=task_binding(read_state(p['path'][0]),migration_scope()['task_id']) or {}
        validate_approval_renewals(root_binding)
        if root_binding.get('migration_id')!=migration_id or root_binding.get('version_plan')!=p:
            raise RuntimeError('renewed plan differs from committed root approval')
        expected=migration_id
    for chat in p['path']:
        st=read_state(chat); b=task_binding(st,migration_scope()['task_id']) or {}
        if b.get('root_request_id')!=migration_scope()['root_request_id']: raise RuntimeError('version path has foreign/missing task enrollment')
        if b.get('task_version')==p['to_version'] and b.get('migration_id')==expected: continue
        if b.get('task_version')!=p['from_version'] or b.get('acceptance_status')!='accepted':
            raise RuntimeError('version path lacks accepted predecessor binding at '+chat)
def install(st,p,binding):
    """One existing state transaction publishes the pointer and pending binding."""
    d=st.get('delegation') or {}
    if d.get('root_request_id')!=migration_scope()['root_request_id']: raise RuntimeError('task not enrolled')
    vs=d.get('task_versions',{}).get(migration_scope()['task_id']) or {}; existing=vs.get('versions',{}).get(str(p['to_version']))
    if existing:
        old=existing['binding']
        if old.get('migration_id')!=binding['migration_id'] or old.get('delivery_message_id')!=binding['delivery_message_id'] or old.get('version_plan')!=p:
            raise RuntimeError('immutable version binding conflict')
        return False
    old=task_binding(st,migration_scope()['task_id'])
    if not old or old.get('task_version')!=p['from_version'] or old.get('acceptance_status')!='accepted':
        raise RuntimeError('from-version must be current and really accepted')
    if binding['delivery_message_id']==old.get('delivery_message_id') or binding['delivery_message_id']==old.get('accepted_message_id'):
        raise RuntimeError('old delivery/acceptance cannot authorize a new version')
    vs=d.setdefault('task_versions',{}).setdefault(migration_scope()['task_id'],{'active_version':p['from_version'],'versions':{}})
    # Keep the original v3 rows byte-for-byte intact. Late transport annotations
    # and rejected old events go into the old-version continuation, never v4.
    stores=d.setdefault('version_tasks',{})
    if str(p['from_version']) not in stores:
        stores[str(p['from_version'])]=copy.deepcopy(d.get('tasks',{}))
    stores.setdefault(str(p['to_version']),{})
    vs['versions'][str(p['to_version'])]={'binding':binding,'prepared_at':ts()}
    vs['active_version']=p['to_version']; st['delegation']=d
    return True
def prepare_root(chat,file,mid,sid,app):
    p=read_plan(file); gated(p); path=topology(p)
    predecessors(p); config_hash=csha(load_config())
    if chat!=path[0]: raise RuntimeError('only the registered root may originate migration')
    control=module('p5-task-control'); ident=control.caller_reader(chat,sid,app)
    projections={ch:auth_projection(read_state(ch)) for ch in path}
    for ch in path: not_paused(p,ch)
    # Same actual reader handles approval AND its cited change sources.
    sources={}
    listed={m.get('message_id'):m for m in list_messages(chat,start=now()-datetime.timedelta(hours=48))}
    for source in [mid]+p['change_evidence_ids']:
        m=listed.get(source)
        if not m or m.get('chat_id')!=chat: raise RuntimeError('version source missing from exact root chat')
        pr=subprocess.run([BOTMUX_BIN,'quoted',source,'--session-id',sid],capture_output=True,text=True,timeout=60,
            env=dict(os.environ,SESSION_DATA_DIR=ident['data_dir'],BOTMUX_LARK_APP_ID=ident['app_id']))
        if pr.returncode: raise RuntimeError('version source quoted failed rc='+str(pr.returncode))
        q=parse_json_tail(pr.stdout)
        if q.get('messageId')!=source or q.get('senderType')!='user' or q.get('senderId')!=owner_id_for_app(ident['app_id']):
            raise RuntimeError('version source not owner in actual root reader view')
        if not isinstance(q.get('content'),str) or not q['content'].strip(): raise RuntimeError('empty version source')
        if not q.get('createTime'): q['createTime']=str(int(msg_time(m).timestamp()*1000))
        sources[source]=q
    q=sources[mid]
    if find_markers(q['content'])!=[envelope(p)]: raise RuntimeError('owner approval does not bind exact plan/documents/path')
    at=datetime.datetime.fromtimestamp(int(q['createTime'])/1000,BJ)
    if not now()-datetime.timedelta(hours=48)<=at<=now()+datetime.timedelta(seconds=60): raise RuntimeError('stale/future owner version approval')
    if any(int(x['createTime'])>int(q['createTime']) for x in sources.values()): raise RuntimeError('approval precedes change sources')
    b={'root_request_id':migration_scope()['root_request_id'],'task_id':migration_scope()['task_id'],'task_version':p['to_version'],'parent_chat':None,'child_chat':chat,
       'delivery_message_id':mid,'delivery_at':q['createTime'],'delivery_kind':'version_owner_intake',
       'migration_id':csha(p),'version_plan':p,'change_sources':{k:{'message_id':k,'body_sha256':sha256b(v['content'].encode()),'created_at':v['createTime']} for k,v in sources.items()},
       'reader_proof':ident,'verified_at':ts(),'acceptance_status':'awaiting_real_acceptance'}
    with AuthLocks(*path):
        gated(p); validate_plan(p)
        if topology(p)!=path or csha(load_config())!=config_hash or control.caller_reader(chat,sid,app)!=ident or any(auth_projection(read_state(ch))!=s for ch,s in projections.items()):
            raise RuntimeError('version authority/reader drift during source verification')
        predecessors(p)
        for ch in path: not_paused(p,ch)
        st=read_state(chat); changed=install(st,p,b)
        if changed: write_state(chat,st)
    print(json.dumps({'prepared':True,'changed':changed,'migration_id':csha(p),'task_version':p['to_version'],'acceptance':'not_synthesized'}))

def verify_engineering_authority(chat,p,proposal_mid,review_mid,ident,want_proposal=None,want_review=None,change_since=None):
    """Task-scoped engineering approval, not semantic guessing or config approval.

    Original verified owner intake establishes the mandate. A registered root
    executor proposes the complete concrete change; an independent registered
    reviewer explicitly approves that exact proposal/plan. The disabled runtime
    gate remains separate. Neither role can approve its own change alone.
    """
    if chat!=p['path'][0] or proposal_mid==review_mid: raise RuntimeError('distinct proposal/review at exact root required')
    control=module('p5-task-control')
    st=read_state(chat); roles=role_apps_for(st); reviewer=roles.get('review') or roles.get('reviewer')
    if not reviewer or reviewer==ident['app_id']: raise RuntimeError('independent registered root reviewer required')
    # This is evidence from the original task intake, not a general-language
    # approval shortcut. It never manufactures new owner intent or intake.
    legacy=st.get('delegation',{}).get('bindings',{}).get(migration_scope()['task_id'],{})
    anchor=legacy.get('anchor') or {}
    if (legacy.get('root_request_id'),legacy.get('task_version'),legacy.get('acceptance_status'),legacy.get('delivery_message_id'),anchor.get('kind'),anchor.get('request_message_id'))!=(migration_scope()['root_request_id'],3,'accepted',migration_scope()['root_request_id'],'root_owner_request',migration_scope()['root_request_id']):
        raise RuntimeError('missing verified original task mandate')
    if not anchor.get('scope_message_id') or not anchor.get('source_thread_id') or not legacy.get('delivery_at'):
        raise RuntimeError('incomplete immutable original mandate')
    stamp=str(legacy['delivery_at'])
    since=(datetime.datetime.fromtimestamp(int(stamp)/1000,BJ) if stamp.isdigit() else datetime.datetime.fromisoformat(stamp).replace(tzinfo=BJ))-datetime.timedelta(days=1)
    request=control.bound_source(chat,migration_scope()['root_request_id'],ident,since)
    scope=control.bound_source(chat,anchor['scope_message_id'],ident,since)
    if (request.get('senderType'),request.get('senderId'))!=('user',owner_id_for_app(ident['app_id'])):
        raise RuntimeError('original mandate not owner in actual reader view')
    if (sha256b(request['content'].encode())!=anchor.get('request_body_sha')
        or sha256b(scope['content'].encode())!=anchor.get('scope_body_sha')
        or request.get('rootId')!=anchor['source_thread_id'] or scope.get('rootId')!=anchor['source_thread_id']
        or int(scope['createTime'])>=int(request['createTime'])):
        raise RuntimeError('original mandate source/thread/bytes mismatch')
    sources={migration_scope()['root_request_id']:request,anchor['scope_message_id']:scope}
    for mid in [*p['change_evidence_ids'],proposal_mid,review_mid]:
        q=control.bound_source(chat,mid,ident,change_since if mid in p['change_evidence_ids'] else None); sources[mid]=q
        if (q.get('senderType'),q.get('senderId')) not in {('app',ident['app_id']),('app',reviewer),('user',owner_id_for_app(ident['app_id']))}:
            raise RuntimeError('change source outside task authority roles')
    proposal=sources[proposal_mid]; approval=sources[review_mid]
    if (proposal.get('senderType'),proposal.get('senderId'))!=('app',ident['app_id']): raise RuntimeError('proposal is not actual root executor')
    if (approval.get('senderType'),approval.get('senderId'))!=('app',reviewer): raise RuntimeError('specific change approval is not independent root reviewer')
    if find_markers(proposal['content'])!=[want_proposal or proposal_envelope(p)]: raise RuntimeError('proposal does not bind concrete change, documents and mandate')
    if find_markers(approval['content'])!=[want_review or review_envelope(p,proposal_mid)]: raise RuntimeError('review does not approve this exact change proposal')
    at=datetime.datetime.fromtimestamp(int(approval['createTime'])/1000,BJ)
    if not now()-datetime.timedelta(hours=48)<=at<=now()+datetime.timedelta(seconds=60): raise RuntimeError('stale/future engineering approval')
    if int(request['createTime'])>int(proposal['createTime']) or int(proposal['createTime'])>int(approval['createTime']) or any(int(sources[mid]['createTime'])>int(proposal['createTime']) for mid in p['change_evidence_ids']):
        raise RuntimeError('proposal/review precedes cited change')
    authorization={'kind':'original_mandate_and_independent_change_review','mandate_message_id':migration_scope()['root_request_id'],
        'proposal_message_id':proposal_mid,'review_message_id':review_mid,'executor_app':ident['app_id'],'reviewer_app':reviewer}
    return authorization,sources

def prepare_delegated(chat,file,proposal_mid,review_mid,sid,app):
    p=read_plan(file); gated(p); path=topology(p); predecessors(p)
    control=module('p5-task-control'); ident=control.caller_reader(chat,sid,app)
    projections={ch:auth_projection(read_state(ch)) for ch in path}; config_hash=csha(load_config())
    for ch in path: not_paused(p,ch)
    authorization,sources=verify_engineering_authority(chat,p,proposal_mid,review_mid,ident)
    approval=sources[review_mid]
    b={'root_request_id':migration_scope()['root_request_id'],'task_id':migration_scope()['task_id'],'task_version':p['to_version'],'parent_chat':None,'child_chat':chat,
       'delivery_message_id':proposal_mid,'delivery_at':approval['createTime'],'delivery_kind':'version_delegated_engineering',
       'migration_id':csha(p),'version_plan':p,'change_sources':{k:{'message_id':k,'body_sha256':sha256b(v['content'].encode()),'created_at':v['createTime']} for k,v in sources.items()},
       'authorization':authorization,
       'reader_proof':ident,'verified_at':ts(),'acceptance_status':'awaiting_real_acceptance'}
    with AuthLocks(*path):
        gated(p); validate_plan(p)
        if topology(p)!=path or csha(load_config())!=config_hash or control.caller_reader(chat,sid,app)!=ident or any(auth_projection(read_state(ch))!=s for ch,s in projections.items()):
            raise RuntimeError('delegated migration authority/reader drift')
        predecessors(p)
        for ch in path: not_paused(p,ch)
        st=read_state(chat); changed=install(st,p,b)
        if changed: write_state(chat,st)
    print(json.dumps({'prepared':True,'changed':changed,'migration_id':csha(p),'task_version':p['to_version'],
        'acceptance':'not_synthesized','authorization':b['authorization'],'runtime_configuration_changed':False}))
def bind_next(child,task,mid):
    if task!=migration_scope()['task_id']: raise RuntimeError('outside task trial')
    cs=read_state(child) or {}; parent=cs.get('parent'); ps=read_state(parent) or {}; pb=task_binding(ps,task) or {}
    p=pb.get('version_plan')
    if not p: raise RuntimeError('parent has no explicit version plan')
    validate_plan(p); gated(p); path=topology(p)
    renewal_mid=pb['migration_id'] if pb.get('approval_renewals') else None
    if renewal_mid: validate_approval_renewals(pb)
    predecessors(p,renewal_mid); config_hash=csha(load_config())
    if child not in path or parent not in path or path.index(child)!=path.index(parent)+1: raise RuntimeError('foreign version edge')
    not_paused(p,child)
    chain={'root_request_id':migration_scope()['root_request_id'],'task_id':migration_scope()['task_id'],'task_version':p['to_version'],'parent_delivery_id':pb['delivery_message_id']}
    why=task_chain_guard(parent,child,task,chain)
    if why: raise RuntimeError(why)
    projections={ch:auth_projection(read_state(ch)) for ch in path}
    binding=module('p5-task-binding'); anchor=binding.delivery_record(parent,child,migration_scope()['root_request_id'],migration_scope()['task_id'],p['to_version'],mid)
    if anchor.get('kind')!='p5_decision': raise RuntimeError('new version needs a NEW standard P5 delivery')
    ent=next(e for e in lifecycle_of(ps)['decisions']['out'] if e.get('decision_id')==anchor['decision_id'])
    payload=json.loads((pathlib.Path(p_outbox(parent))/(ent['decision_id']+'.payload.json')).read_text())
    if any(payload.get(k)!=ent.get(k) for k in ('decision_id','exec_ou','body_sha','chain')):
        raise RuntimeError('immutable payload metadata differs from committed decision')
    body=payload.get('text',payload.get('body'))
    if not isinstance(body,str) or any(x not in body for x in version_contract_text(pb)): raise RuntimeError('payload lacks exact version/document contract')
    msgs=list_messages(child,start=now()-datetime.timedelta(hours=48)); m=next((x for x in msgs if x.get('message_id')==mid),None)
    if not m or m.get('chat_id')!=child or m.get('sender',{}).get('sender_type')!='user' or m['sender'].get('id')!=owner_id_for_app(m.get('_reader_app_id')):
        raise RuntimeError('delivery not owner in exact target/reader view')
    if not exact_single_mention(m,{cs.get('executor_ou'),executor_app(cs)}): raise RuntimeError('delivery not exactly addressed to executor')
    # The rendered quoted content removes mention placeholders and trims text.
    # Verify the original transport envelope through the SAME bound reader;
    # missing raw bytes must never fall back to the lossy display/cache body.
    q=quoted_message(m,raw=True)
    if m.get('msg_type')!='text' or q.get('msgType')!='text': raise RuntimeError('delivery must be a standard text envelope')
    try: raw=json.loads(q['rawContent']); text=raw['text']
    except (KeyError,TypeError,ValueError): raise RuntimeError('delivery raw text envelope missing or invalid')
    if not isinstance(text,str): raise RuntimeError('delivery raw text is not a string')
    want={'decision_id':ent['decision_id'],'body_sha':ent['body_sha'],'exec_ou':ent['exec_ou']}
    prefix=re.match(r'^(?:<at user_id="(?P<id>[^"]+)">[^<]*</at>|(?P<key>@\S+))[ \t]*',text)
    mention=m['mentions'][0]
    if not prefix or (prefix.group('id') not in {mention.get('id'),ent['exec_ou']} if prefix.group('id') else prefix.group('key')!=mention.get('key')):
        raise RuntimeError('delivery mention token not at exact registered envelope position')
    canonical_body=encode_marker(want)+' '+body
    checks={'body':text[prefix.end():]==canonical_body,'marker':len(MARK_RE.findall(text))==1 and find_markers(text)==[want],
        'body_sha':sha256b(body.encode())==ent['body_sha'],'payload_chain':payload.get('chain')==chain}
    if not all(checks.values()):
        raise RuntimeError('delivery body/envelope differs from committed payload: '+','.join(k for k,v in checks.items() if not v))
    b={'root_request_id':migration_scope()['root_request_id'],'task_id':migration_scope()['task_id'],'task_version':p['to_version'],'parent_chat':parent,'child_chat':child,
       'delivery_message_id':mid,'delivery_at':q.get('createTime') or m['create_time'],'anchor':anchor,'migration_id':pb['migration_id'],
       'version_plan':p,'change_sources':pb['change_sources'],'verified_at':ts(),'acceptance_status':'awaiting_real_acceptance'}
    if pb.get('approval_renewals'): b['approval_renewals']=copy.deepcopy(pb['approval_renewals'])
    with AuthLocks(*path):
        gated(p); validate_plan(p); topology(p); not_paused(p,child); predecessors(p,renewal_mid)
        if csha(load_config())!=config_hash or any(auth_projection(read_state(ch))!=s for ch,s in projections.items()) or binding.delivery_record(parent,child,migration_scope()['root_request_id'],migration_scope()['task_id'],p['to_version'],mid)!=anchor:
            raise RuntimeError('version binding/delivery drift before commit')
        cs=read_state(child); changed=install(cs,p,b)
        if changed: write_state(child,cs)
    print(json.dumps({'bound':True,'changed':changed,'migration_id':pb['migration_id'],'task_version':p['to_version'],'acceptance':'not_synthesized'}))
if __name__=='__main__':
    try:
        if sys.argv[1:2]==['plan'] and len(sys.argv)==3: print(encode_marker(envelope(read_plan(sys.argv[2]))))
        elif sys.argv[1:2]==['proposal'] and len(sys.argv)==3: print(encode_marker(proposal_envelope(read_plan(sys.argv[2]))))
        elif sys.argv[1:2]==['review-source'] and len(sys.argv)==4: print(encode_marker(review_envelope(read_plan(sys.argv[2]),sys.argv[3])))
        elif sys.argv[1:2]==['prepare-root'] and len(sys.argv)==7: prepare_root(*sys.argv[2:])
        elif sys.argv[1:2]==['prepare-delegated'] and len(sys.argv)==8: prepare_delegated(*sys.argv[2:])
        elif sys.argv[1:2]==['bind-next'] and len(sys.argv)==5: bind_next(*sys.argv[2:])
        elif sys.argv[1:2]==['renewal-plan'] and len(sys.argv)==4: print(json.dumps(module('p5renewal').request(*sys.argv[2:]),ensure_ascii=False))
        elif sys.argv[1:2]==['renewal-proposal'] and len(sys.argv)==3: print(encode_marker(module('p5renewal').proposal(json.loads(pathlib.Path(sys.argv[2]).read_text()))))
        elif sys.argv[1:2]==['renewal-review-source'] and len(sys.argv)==4: print(encode_marker(module('p5renewal').review(json.loads(pathlib.Path(sys.argv[2]).read_text()),sys.argv[3])))
        elif sys.argv[1:2]==['renew-approval'] and len(sys.argv)==8: print(json.dumps(module('p5renewal').renew(*sys.argv[2:]),ensure_ascii=False))
        elif sys.argv[1:2]==['renewal-recover'] and len(sys.argv)==6: print(json.dumps(module('p5renewal').recover(*sys.argv[2:]),ensure_ascii=False))
        else: raise RuntimeError(__doc__)
    except Exception as e: print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False)); raise SystemExit(9)
