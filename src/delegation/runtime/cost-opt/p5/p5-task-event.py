#!/usr/bin/env python3
"""Task-level event propagation on the existing P5 bubble/outbox path.

Commands:
  emit <chat> <root_request_id> <task_id> <task_version> <event_version>
       <event_type> <occurred_at> <evidence_message_id>
  ingest <parent_chat>
  flush <child_chat>
  reconcile-sent <child_chat> <event_id> <event_sha256> <message_id>
                 <receiver_confirmation_id> <confirmation_body_sha256>
  status <chat> <root_request_id> <task_id>

An event is stored locally before a bubble is queued.  Each parent verifies the
registered child and the child's sent receipt, stores the source event, then
queues the same event for its own parent. Rejected events travel once as audit
facts with sticky rejection provenance; duplicate receipts never re-notify.
"""
import datetime, hashlib, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
import p5summary
# Same lark-cli profile p5lib already uses to read as the observer app; the
# wake nudge must come from an app the parent does not filter as its own.
OBSERVER_PROFILE='dafeijing'

EVENT_TYPES = {
    'accepted': ('accepted', 10), 'queued': ('queued', 20),
    'started': ('in_progress', 30), 'milestone': ('in_progress', 40),
    'blocked': ('blocked', 50), 'paused': ('paused', 60),
    'pause_released': ('resume_pending', 65),
    'resumed': ('in_progress', 70),
    'result_pending_review': ('pending_review', 80),
    'review_passed': ('completed', 90), 'failed': ('failed', 90),
}
def require_trial(st):
    if not st or (st.get('delegation') or {}).get('root_request_id')!=delegation_identity()[0]:
        raise RuntimeError('task event trial not enrolled; no automatic migration or notification')

def event_key(root, task, origin): return hashlib.sha256(canonical([root,task,origin]).encode()).hexdigest()
def parse_time(v): return datetime.datetime.strptime(v, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BJ)
def delegation(st):
    d=st.get('delegation')
    if not isinstance(d,dict): d={'schema_version':1,'tasks':{}}
    if not isinstance(d.get('tasks'),dict): d['tasks']={}
    return d
def task_store(d,task,version=None):
    vs=d.get('task_versions',{}).get(task) or {}
    if not vs: return d['tasks']
    if version is None: version=vs['active_version']
    return d.setdefault('version_tasks',{}).setdefault(str(version),{})
def task_of(d,root,task,origin,version=None): return task_store(d,task,version).get(event_key(root,task,origin))
def version_event_guard(st,ev):
    """No event can implicitly upgrade a declared task or reactivate old work."""
    task=ev['task_id']; b=task_binding(st,task) or {}; v=ev['task_version']
    if not b.get('migration_id'):
        if b.get('task_version')==3 and v>3: return 'unbound_task_version'
        return ''  # Existing v3/legacy fixtures retain their historical rules.
    if v<b['task_version']: return 'stale_task_version'
    if v!=b['task_version']: return 'unbound_task_version'
    origin=ev['origin_chat']; ob=task_binding(st if origin==st.get('chat_id') else read_state(origin),task) or {}
    if ob.get('migration_id')!=b['migration_id'] or ob.get('task_version')!=v: return 'unbound_task_version'
    if origin!=st.get('chat_id') and (not registered_descendant(origin,st.get('chat_id')) or b.get('acceptance_status')!='accepted'):
        return 'unbound_task_version'
    if not (origin==st.get('chat_id') and ev['event_type']=='accepted') and ob.get('acceptance_status')!='accepted':
        return 'unbound_task_version'
    return ''
def is_current_event(t,ev):
    return (t and t.get('task_version')==ev['task_version'] and t.get('applied_event_version')==ev['event_version']
            and any(r.get('event_id')==ev['event_id'] and r.get('applied') for r in t.get('events',[])))
REJECT_REASONS = {'paused_no_reactivation','stale_task_version','out_of_order',
    'version_conflict','resume_requires_new_task_version','terminal_no_reactivation',
    'resume_requires_bound_control','resume_requires_fresh_acceptance',
    'review_requires_pending_result','stage_regression','unbound_task_version',
    'release_requires_bound_control','released_requires_new_task_version'}
def validate_rejections(ev, rejections):
    if not isinstance(rejections,list): raise RuntimeError('invalid rejection chain')
    seen=set()
    for r in rejections:
        if not isinstance(r,dict) or set(r)!={'chat_id','reason','event_id','rejected_at'}:
            raise RuntimeError('invalid rejection provenance')
        if not isinstance(r['chat_id'],str) or not r['chat_id'].startswith('oc_') or r['chat_id'] in seen:
            raise RuntimeError('invalid/duplicate rejection source')
        if r['reason'] not in REJECT_REASONS or r['event_id']!=ev['event_id']:
            raise RuntimeError('invalid rejection reason/event binding')
        parse_time(r['rejected_at']); seen.add(r['chat_id'])
    return rejections
def rejections_for(st, ev):
    t=task_of(delegation(st),ev['root_request_id'],ev['task_id'],ev['origin_chat'],ev['task_version'])
    records=[r for r in (t or {}).get('events',[]) if r.get('event_id')==ev['event_id']]
    if len(records)!=1 or not same_event(records[0],ev):
        raise RuntimeError('rejection provenance lacks committed source event')
    rec=records[0]; inherited=validate_rejections(ev,rec.get('downstream_rejections',[]))
    if inherited:
        if rec.get('applied') or rec.get('reject_reason')!='rejected_downstream':
            raise RuntimeError('downstream rejection was not preserved')
        return list(inherited)
    reason=rec.get('reject_reason')
    if reason:
        if rec.get('applied'): raise RuntimeError('rejected event marked applied')
        return validate_rejections(ev,[{'chat_id':st.get('chat_id'),'reason':reason,
            'event_id':ev['event_id'],'rejected_at':rec['landed_at']}])
    if not rec.get('applied'): raise RuntimeError('unexplained event rejection')
    return []
def verify_bubble_rejections(st,b):
    actual=validate_rejections(b['event'],b.get('rejections',[]))
    if actual!=rejections_for(st,b['event']):
        raise RuntimeError('bubble rejection provenance mismatch; repair pending queue before flush')
    return actual
def event_marker(ev, source_chat, rejections=None, summary=None):
    keys=('event_id','root_request_id','task_id','task_version','event_version','event_type','occurred_at','origin_chat','evidence_message_id')
    x={k:ev.get(k) for k in keys}; x.update({'task_event':ev['event_id'],'source_chat':source_chat})
    # Legacy pause markers remain byte-identical. New recovery receipts bind
    # their control metadata both in the wire and the committed source record.
    if ev.get('event_type') in ('pause_released','resumed'):
        x.update({k:ev.get(k) for k in CONTROL_EVENT_KEYS})
    if rejections: x['rejections']=validate_rejections(ev,rejections)
    if ev.get('source_report') is not None: x['source_report_sha256']=csha(ev['source_report'])
    if summary is not None: x['summary_sha256']=csha(summary)
    return x
def event_id(root,task,tver,ever,origin,etype,evidence):
    return sha256b(canonical([root,task,tver,ever,origin,etype,evidence]).encode())
CONTROL_EVENT_KEYS=('derived_from_control','control_origin_chat','control_source_message_id','resumes_control_id')
def same_event(a,b):
    keys=('event_id','root_request_id','task_id','task_version','event_version','event_type','occurred_at','origin_chat','evidence_message_id')
    return all(a.get(k)==b.get(k) for k in keys+CONTROL_EVENT_KEYS) and a.get('source_report')==b.get('source_report')
def message_body(m):
    if m.get('msg_type') not in ('interactive','post'): return msg_text(m)
    return quoted_message(m).get('content') or ''
def event_text(ev, child, rejections=None, summary=None):
    text=f'{encode_marker(event_marker(ev,child,rejections,summary))} task-event {ev["event_type"]} root={ev["root_request_id"]} task={ev["task_id"]} v={ev["task_version"]}/{ev["event_version"]} occurred_at={ev["occurred_at"]} evidence={ev["evidence_message_id"]}'
    return text+('\n'+p5summary.render(summary) if summary is not None else '')
def exact_event_message(m,ev,child):
    bubbles=lifecycle_of(read_state(child))['bubbles']['out']
    b=next((b for b in bubbles if b.get('kind')=='task_event' and b.get('event_id')==ev['event_id']),{})
    route=b.get('route') or {}; s=m.get('sender',{}); mentions=m.get('mentions') or []
    if not (route.get('sender_app') and s.get('sender_type')=='app' and s.get('id')==route['sender_app']
            and m.get('chat_id')==route.get('target_chat')): return False
    if exact_single_mention(m,{route.get('target_app'),route.get('target_open_id')}):
        return message_body(m)==event_text(ev,child,b.get('rejections',[]),b.get('summary'))
    return reconciled_event_message(m,ev,child,b)

def reconciliation_original_body(original):
    """Read exact stored content, not the presentation-layer quoted text."""
    if original.get('deleted') is not False:
        raise RuntimeError('reconciliation original message deleted or deletion status unavailable')
    q=quoted_message(original,raw=True)
    if q.get('msgType')!=original.get('msg_type'):
        raise RuntimeError('reconciliation original message type mismatch')
    if q['msgType']=='text':
        raw=q.get('rawContent')
        if isinstance(raw,str): raw=json.loads(raw)
        body=raw.get('text') if isinstance(raw,dict) else None
        source='rawContent.text'
    elif q['msgType']=='interactive':
        card=q.get('cardJson')
        if isinstance(card,str): card=json.loads(card)
        elements=(card.get('body') or {}).get('elements') if isinstance(card,dict) else None
        if not isinstance(elements,list) or len(elements)!=1 or elements[0].get('tag')!='markdown':
            raise RuntimeError('reconciliation original card must contain one exact markdown body')
        body=elements[0].get('content'); source='cardJson.body.elements[0].content'
    else: raise RuntimeError('reconciliation unsupported original message type')
    if not isinstance(body,str): raise RuntimeError('reconciliation original raw body unavailable')
    return body,{'deleted':False,'msg_type':q['msgType'],'body_source':source}

def reconciliation_evidence(child,b,mid,confirmation_id,confirmation_sha,message=None):
    """Read an old delivery and the receiver's explicitly selected confirmation.

    The operator must read the confirmation before supplying its body digest.
    Natural-language intent is not parsed as an automatic receipt: this helper
    checks the selected evidence, while reconcile-sent records the decision.
    """
    ev=b['event']; route=b.get('route') or {}; parent=route.get('target_chat')
    st=read_state(child) or {}; pst=read_state(parent) or {}
    if st.get('parent')!=parent or child not in (pst.get('children') or []):
        raise RuntimeError('reconciliation topology differs from committed route')
    if not route.get('sender_app') or not route.get('target_app'):
        raise RuntimeError('reconciliation lacks original sender/receiver route')
    if not re.fullmatch('[a-f0-9]{64}',confirmation_sha):
        raise RuntimeError('invalid receiver confirmation body sha256')
    messages=list_messages(parent,start=parse_time(b['pending_at'])-datetime.timedelta(minutes=10))
    def selected(message_id):
        matches=[x for x in messages if x.get('message_id')==message_id]
        if len(matches)!=1: raise RuntimeError('reconciliation message missing/ambiguous: '+message_id)
        return matches[0]
    original=selected(mid)  # Always use the fresh list row, including deleted.
    if original.get('message_id')!=mid or original.get('chat_id')!=parent:
        raise RuntimeError('reconciliation original message target/id mismatch')
    sender=original.get('sender') or {}
    if sender.get('sender_type')!='app' or sender.get('id')!=route['sender_app']:
        raise RuntimeError('reconciliation original sender mismatch')
    if original.get('mentions'):
        raise RuntimeError('reconciliation is only for a missing-mention delivery')
    body,readback=reconciliation_original_body(original)
    if body!=event_text(ev,child,b.get('rejections',[]),b.get('summary')):
        raise RuntimeError('reconciliation original body differs from committed event')
    confirmation=selected(confirmation_id); sender=confirmation.get('sender') or {}
    if (confirmation_id==mid or confirmation.get('chat_id')!=parent
            or sender.get('sender_type')!='app' or sender.get('id')!=route['target_app']):
        raise RuntimeError('reconciliation confirmation is not from original receiver')
    text=quoted_message(confirmation).get('content') or ''
    if sha256b(text.encode())!=confirmation_sha or mid not in text:
        raise RuntimeError('reconciliation confirmation body/id reference mismatch')
    if msg_time(confirmation)<msg_time(original):
        raise RuntimeError('reconciliation confirmation predates original delivery')
    return {'kind':'receiver_confirmed_missing_mention','version':1,
        'delivery_mode':'reconciled_without_mention','original_readback':readback,'source_chat':child,
        'target_chat':parent,'event_id':ev['event_id'],'event_sha256':csha(ev),
        'message_id':mid,'sender_app':route['sender_app'],'body_sha256':sha256b(body.encode()),
        'confirmation':{'message_id':confirmation_id,'sender_app':route['target_app'],
                        'body_sha256':confirmation_sha,'created_at':msg_time(confirmation).isoformat()}}

def reconciled_event_message(m,ev,child,b):
    audit=b.get('receipt_reconciliation')
    if not audit or m.get('message_id')!=audit.get('message_id') or m.get('mentions'): return False
    if b.get('state')!='sent' or b.get('sent_message_id')!=m['message_id']: return False
    path=os.path.join(p_outbox(child),'event-'+ev['event_id']+'.sent')
    with open(path,encoding='utf-8') as f: receipt=json.load(f)
    if (receipt.get('reconciliation')!=audit or receipt.get('message_id')!=m['message_id']
            or receipt.get('event_sha')!=csha(ev) or receipt.get('event_id')!=ev['event_id']
            or receipt.get('source_chat')!=child or receipt.get('target_chat')!=m.get('chat_id')):
        raise RuntimeError('reconciliation receipt differs from committed audit')
    confirmation=audit.get('confirmation') or {}
    actual=reconciliation_evidence(child,b,m['message_id'],confirmation.get('message_id'),
                                   confirmation.get('body_sha256',''),message=m)
    if any(audit.get(k)!=v for k,v in actual.items()):
        raise RuntimeError('reconciliation readback differs from recorded evidence')
    return True

def cmd_reconcile_sent(child,eid,event_sha,mid,confirmation_id,confirmation_sha):
    """Explicitly reconcile an already delivered message; never call send_report."""
    if not re.fullmatch('[a-f0-9]{64}',eid): raise RuntimeError('invalid reconciliation event_id')
    st=read_state(child); ok,why=managed_state(st)
    if not ok: raise RuntimeError('reconciliation source not managed: '+why)
    require_trial(st)
    ob=p_outbox(child); os.makedirs(ob,exist_ok=True)
    lock=os.open(os.path.join(ob,'event-'+eid+'.lock'),os.O_RDWR|os.O_CREAT,0o644)
    fcntl.flock(lock,fcntl.LOCK_EX)
    try:
        st=read_state(child)
        matches=[b for b in lifecycle_of(st)['bubbles']['out'] if b.get('kind')=='task_event' and b.get('event_id')==eid]
        if len(matches)!=1: raise RuntimeError('reconciliation event missing/ambiguous')
        b=matches[0]; ev=b['event']; validate_event(ev); verify_bubble_rejections(st,b)
        if event_sha!=csha(ev): raise RuntimeError('reconciliation event sha256 mismatch')
        if b.get('summary') is not None and csha(b['summary'])!=b.get('summary_sha256'):
            raise RuntimeError('reconciliation committed summary mismatch')
        prior=b.get('receipt_reconciliation')
        expected_error='event send not verified on exact parent/message/sender/body: '+mid
        if prior:
            if b.get('state')!='sent' or b.get('sent_message_id')!=mid:
                raise RuntimeError('reconciliation state/id differs from prior audit')
        elif (b.get('state')!='sending' or b.get('last_error')!=expected_error
              or not b.get('sending_at') or not b.get('attempts') or b.get('sent_message_id')):
            raise RuntimeError('reconciliation requires the exact failed sending attempt')
        evidence=reconciliation_evidence(child,b,mid,confirmation_id,confirmation_sha)
        if prior and any(prior.get(k)!=v for k,v in evidence.items()):
            raise RuntimeError('reconciliation differs from prior audit')
        receipt_path=os.path.join(ob,'event-'+eid+'.sent')
        saved=None
        if os.path.exists(receipt_path):
            with open(receipt_path,encoding='utf-8') as f: saved=json.load(f)
        audit=prior or (saved or {}).get('reconciliation') or dict(evidence,
            reconciled_at=ts(),previous_error=b.get('last_error'),previous_error_at=b.get('last_error_at'))
        if any(audit.get(k)!=v for k,v in evidence.items()):
            raise RuntimeError('reconciliation differs from saved receipt')
        receipt={'message_id':mid,'at':audit['reconciled_at'],'source_chat':child,
                 'target_chat':evidence['target_chat'],'event_id':eid,'event_sha':event_sha,'reconciliation':audit}
        if saved is not None and saved!=receipt: raise RuntimeError('reconciliation will not overwrite a different receipt')
        if prior:
            if saved!=receipt: raise RuntimeError('reconciliation committed receipt missing')
            print(json.dumps({'reconciled':True,'changed':False,'sent':True,'message_id':mid,
                              'external_sends':0,'parent_landed':bool(b.get('parent_landed_at'))})); return
        with ChatLock(child):
            live=read_state(child); lc=lifecycle_of(live)
            current=[x for x in lc['bubbles']['out'] if x.get('kind')=='task_event' and x.get('event_id')==eid]
            if len(current)!=1 or current[0]!=b: raise RuntimeError('reconciliation bubble changed during readback')
            if (live.get('parent')!=evidence['target_chat']
                    or child not in ((read_state(evidence['target_chat']) or {}).get('children') or [])):
                raise RuntimeError('reconciliation topology changed during readback')
            verify_bubble_rejections(live,current[0])
            # Same event lock as flush. A crash after this receipt is written
            # can be completed by repeating the identical reconciliation.
            if saved is None: atomic_write(receipt_path,json.dumps(receipt,ensure_ascii=False).encode())
            cur=current[0]; cur.update(state='sent',sent_message_id=mid,sent_at=audit['reconciled_at'],receipt_reconciliation=audit)
            cur.pop('last_error',None); cur.pop('last_error_at',None)
            t=task_of(delegation(live),ev['root_request_id'],ev['task_id'],ev['origin_chat'],ev['task_version'])
            if is_current_event(t,ev): t['sync_status']='sent_unconfirmed'; t['sync_error']=None
            for rec in t['events']:
                if rec.get('event_id')==eid: rec.update(forwarded_message_id=mid,forwarded_at=audit['reconciled_at'])
            live['lifecycle']=lc; write_state(child,live)
        print(json.dumps({'reconciled':True,'changed':True,'sent':True,'message_id':mid,
                          'external_sends':0,'parent_landed':False,'reconciliation':audit},ensure_ascii=False))
    finally: fcntl.flock(lock,fcntl.LOCK_UN); os.close(lock)

def report_route(child,parent):
    # Resolve app-scoped mention handles through this sender's current runtime.
    rc,out,err=run([BOTMUX_BIN,'bots','list'])
    if rc: raise RuntimeError('report roster failed: '+err[:120])
    roster=parse_json_tail(out); bots=roster.get('bots') or []
    selves=[b for b in bots if b.get('isSelf')]
    if len(selves)!=1: raise RuntimeError('report sender identity missing/ambiguous')
    sender=selves[0].get('larkAppId')
    allowed=set(role_apps_for(read_state(child)).values())|{observer_app()}
    if not sender or sender not in allowed: raise RuntimeError('report sender is not a registered node role')
    target=executor_app(read_state(parent))
    # The parent's executor is the only reader who can act on this report, so it
    # must be the one mentioned. Sharing an app id with the sender does NOT make
    # this a self-mention: the parent chat runs its own session, and mentioning
    # that app there is what wakes it. Redirecting to the observer instead left
    # every codex->codex hop waking nobody but a bookkeeper (2026-09-10).
    if parent==child: raise RuntimeError('no distinct parent receiver; self-mention cannot prove receipt')
    if not target: raise RuntimeError('parent executor app unregistered; cannot address a reader')
    hits=[b for b in bots if b.get('larkAppId')==target and b.get('mentionable') and b.get('openId')]
    if len(hits)!=1: raise RuntimeError('parent receiver has no unambiguous runtime mention handle')
    # Same app on both ends: the report still addresses the parent's executor,
    # but the parent daemon drops it as its own echo (event-dispatcher's
    # isSelfMessage is app-wide, not per-chat), so the mention alone wakes
    # nobody. The caller must follow up from a different app. See wake_parent.
    return {'sender_app':sender,'target_app':target,'target_open_id':hits[0]['openId'],
            'target_chat':parent,'self_filtered':sender==target}

def wake_parent(parent,target_app,pending):
    """Nudge a parent whose executor shares our app, from an app it will read.

    The protocol report itself is untouched: it keeps the registered sender,
    the exact single mention and the byte-exact body the parent's ingest
    verifies. This is a separate, marker-free message whose only job is to make
    the parent's session wake up and go read what already landed.
    """
    rc,out,err=run([LARK_BIN,'im','+chat-members-list','--chat-id',parent,'--profile',OBSERVER_PROFILE,
                    '--as','bot','--member-types','bot'],timeout=60)
    if rc: raise RuntimeError('wake roster failed: '+err[:120])
    members=(parse_json_tail(out).get('data') or {}).get('bots') or []
    hits=[b.get('member_id') for b in members if b.get('app_id')==target_app and b.get('member_id')]
    if len(hits)!=1: raise RuntimeError('wake target has no unambiguous member id in parent chat')
    text=(f'<at user_id="{hits[0]}"></at> 子群已投递 {pending} 条任务上报到本群，'
          '因为收发双方是同一个应用，那几条不会自动唤醒你。请按既有入口读取并落账。')
    rc,out,err=run([LARK_BIN,'im','+messages-send','--chat-id',parent,'--profile',OBSERVER_PROFILE,
                    '--as','bot','--text',text],timeout=60)
    if rc: raise RuntimeError('wake send failed: '+err[:120])
    mid=(parse_json_tail(out).get('data') or {}).get('message_id')
    if not mid: raise RuntimeError('wake send lacks message_id')
    return mid

def send_report(route,text):
    rc,out,err=run([BOTMUX_BIN,'send','--top-level','--no-quote','--chat-id',route['target_chat'],'--mention',route['target_open_id']],input=text,timeout=60)
    if rc: raise RuntimeError('report send uncertain rc='+str(rc)+' '+err[:120])
    obj=parse_json_tail(out)
    if not obj.get('success') or not obj.get('messageId'): raise RuntimeError('report send lacks exact message_id')
    return obj['messageId']
def source_evidence(chat, ev):
    """Origin events must be tied to one real message and the registered role app."""
    start=parse_time(ev['occurred_at'])-datetime.timedelta(minutes=10)
    msgs=list_messages(chat,start=start); m=next((x for x in msgs if x.get('message_id')==ev['evidence_message_id']),None)
    if not m: return False,'evidence message not found'
    if abs((msg_time(m)-parse_time(ev['occurred_at'])).total_seconds())>60:
        return False,'occurred_at not tied to actual evidence message time'
    s=m.get('sender',{}); roles=role_apps_for(read_state(chat)); et=ev['event_type']
    if et=='review_passed': allowed={roles.get('review'),roles.get('reviewer')}
    elif et=='resumed':
        if not committed_resumption(read_state(chat),ev): return False,'resumed requires current landed recovery control and accepted generation'
        c=(read_state(chat).get('delegation') or {}).get('controls',{}).get(ev['task_id'],{})
        kind=c.get('release_authority',{}).get('kind')
        allowed=({roles.get('worker'),roles.get('executor')} if kind=='executor' else
                 {owner_id_for_app(m.get('_reader_app_id'))} if kind=='owner' else set())
    elif et=='paused': allowed={owner_id_for_app(m.get('_reader_app_id'))}
    else: allowed={roles.get('worker'),roles.get('executor')}
    if s.get('sender_type')=='app': actual=s.get('id')
    elif s.get('sender_type')=='user': actual=s.get('id')
    else: actual=None
    if actual not in {x for x in allowed if x}: return False,f'evidence sender {actual} not allowed for {et}'
    if m.get('msg_type') in ('interactive','post') or et=='resumed':
        # Listing a card may return null or a placeholder. Never infer its
        # business verdict without reading the exact message body.
        try: body=quoted_message(m).get('content') or ''
        except Exception as e: return False,str(e)
    else: body=msg_text(m)
    for needle in (ev['root_request_id'],ev['task_id']):
        if needle not in body: return False,f'evidence body missing {needle}'
    if et=='accepted':
        binding=task_binding(read_state(chat),ev['task_id']) or {}
        delivery=binding.get('delivery_message_id')
        if not delivery or delivery not in body: return False,'acceptance lacks bound delivery_message_id'
        if not re.search(r'(?:任务书版本|task_version)\s*[=:：]\s*`?'+str(ev['task_version'])+r'\b',body): return False,'acceptance lacks exact task version'
        if not any(x in body.lower() for x in ('已接单','accepted')): return False,'acceptance evidence lacks accepted/已接单'
        if any(x not in body for x in version_contract_text(binding)): return False,'acceptance lacks new migration/document binding'
        if binding.get('migration_id'):
            at=binding['delivery_at']
            delivery_time=(datetime.datetime.fromtimestamp(int(at)/1000,BJ) if str(at).isdigit() else datetime.datetime.fromisoformat(at).replace(tzinfo=BJ))
            try:
                q=quoted_message(m)
                if q.get('content')!=body or not q.get('createTime'): return False,'new acceptance requires exact quoted body/time'
                accepted_time=datetime.datetime.fromtimestamp(int(q['createTime'])/1000,BJ)
            except Exception as e: return False,str(e)
            if accepted_time<delivery_time: return False,'acceptance predates new delivery'
    else:
        want={k:ev[k] for k in ('root_request_id','task_id','task_version','event_version','event_type','origin_chat')}
        if et=='resumed': want.update({k:ev.get(k) for k in CONTROL_EVENT_KEYS})
        if [mk['task_event_source'] for mk in find_markers(body) if 'task_event_source' in mk]!=[want]: return False,'event source envelope mismatch'
    if ev.get('source_report') is not None:
        if [mk['task_report'] for mk in find_markers(body) if 'task_report' in mk]!=[ev['source_report']]:
            return False,'source report is not the exact evidenced report'
    return True,''

def sync_failure(chat, ev, error):
    with ChatLock(chat):
        s=read_state(chat); lc=lifecycle_of(s)
        for b in lc['bubbles']['out']:
            if b.get('kind')=='task_event' and b.get('event_id')==ev['event_id']:
                b['last_error']=str(error); b['last_error_at']=ts()
        d=delegation(s); t=task_of(d,ev['root_request_id'],ev['task_id'],ev['origin_chat'],ev['task_version'])
        if is_current_event(t,ev): t['sync_status']='retry_pending'; t['sync_error']=str(error); s['delegation']=d
        s['lifecycle']=lc; write_state(chat,s)
def local_control_pause(st, ev):
    """Only the receipt of this node's committed control may reaffirm paused.

    This is not permission for a descendant's pause, a plain owner event, or
    caller-supplied control metadata to bypass the paused-state guard.
    """
    c=(delegation(st).get('controls') or {}).get(ev['task_id']) or {}
    return bool(c.get('control_id') and c.get('state')=='paused' and c.get('action')=='pause'
        and ev['event_type']=='paused' and ev['origin_chat']==st.get('chat_id')
        and ev.get('derived_from_control')==c['control_id']
        and ev['root_request_id']==c.get('root_request_id') and ev['task_version']==c.get('task_version')
        and ev['evidence_message_id']==c.get('source_message_id')
        and ev.get('control_source_message_id')==c.get('evidence_message_id')
        and ev.get('control_origin_chat')==c.get('origin_chat')
        and ev['occurred_at']==c.get('landed_at'))
def same_control_pause_receipt(st, ev):
    """A registered descendant may report the SAME control already in force.

    The child's committed sent event is checked by ingest. Here additionally
    bind the current applicable control and the origin's actual local landing;
    another subtree/control/source cannot reaffirm a paused branch.
    """
    if local_control_pause(st,ev): return True
    if ev['origin_chat']==st.get('chat_id') or ev['event_type']!='paused': return False
    c=task_control_for(st,ev['task_id'],ev['origin_chat'])
    if not (c.get('control_id') and c.get('state')=='paused' and c.get('action')=='pause'
            and ev.get('derived_from_control')==c['control_id']
            and ev.get('control_source_message_id')==c.get('evidence_message_id')
            and ev.get('control_origin_chat')==c.get('origin_chat')
            and ev['root_request_id']==c.get('root_request_id')
            and ev['task_version']==c.get('task_version')): return False
    if not registered_descendant(ev['origin_chat'],st.get('chat_id')): return False
    origin=read_state(ev['origin_chat'])
    return bool(origin and local_control_pause(origin,ev))

def local_control_release(st,ev):
    d=delegation(st); c=(d.get('controls') or {}).get(ev['task_id']) or {}
    old=(d.get('control_history') or {}).get(c.get('resumes_control_id')) or {}
    return bool(ev['event_type']=='pause_released' and ev['origin_chat']==st.get('chat_id')
        and c.get('action')=='resume' and c.get('state')=='released'
        and old.get('state')=='paused' and old.get('action')=='pause'
        and c.get('control_version')==old.get('control_version',-2)+1
        and all(c.get(k)==old.get(k) for k in ('root_request_id','task_id','task_version','origin_chat','scope','target_child'))
        and c.get('resumes_source_message_id')==old.get('evidence_message_id')
        and c.get('resume_task_version')==old.get('task_version',-2)+1
        and ev.get('resumes_control_id')==old.get('control_id')
        and ev.get('derived_from_control')==c.get('control_id')
        and ev['root_request_id']==c.get('root_request_id') and ev['task_version']==c.get('task_version')
        and ev['evidence_message_id']==c.get('source_message_id')
        and ev.get('control_source_message_id')==c.get('evidence_message_id')
        and ev.get('control_origin_chat')==c.get('origin_chat') and ev['occurred_at']==c.get('landed_at'))

def committed_release_receipt(st,ev):
    if ev['origin_chat']==st.get('chat_id'): return local_control_release(st,ev)
    if ev['event_type']!='pause_released' or not registered_descendant(ev['origin_chat'],st.get('chat_id')): return False
    origin=read_state(ev['origin_chat'])
    if not origin or not local_control_release(origin,ev): return False
    c=task_control_for(st,ev['task_id'],ev['origin_chat'])
    # Ancestors outside a branch scope need no local copy, but cannot override
    # another pause. The origin's exact local anchor and sent receipt are still
    # required; this deliberately retains the single-host state trust boundary.
    return not c or (c.get('state')=='released' and c.get('control_id')==ev.get('derived_from_control'))

def committed_resumption(st,ev):
    """Business resume is a derived, new-generation control consequence."""
    if ev['event_type']!='resumed': return False
    origin=read_state(ev['origin_chat'])
    if not origin or not registered_descendant(ev['origin_chat'],st['chat_id']): return False
    d=origin.get('delegation') or {}; c=d.get('controls',{}).get(ev['task_id'],{})
    binding=task_binding(origin,ev['task_id']) or {}; plan=binding.get('version_plan') or {}
    if (c.get('state')!='released' or c.get('action')!='resume' or not c.get('release_authority')
        or binding.get('acceptance_status')!='accepted' or not binding.get('migration_id')
        or ev['task_version']!=binding.get('task_version') or ev['task_version']!=c.get('resume_task_version')
        or plan.get('from_version')!=c.get('task_version') or ev['root_request_id']!=c.get('root_request_id')): return False
    expected={'derived_from_control':c.get('control_id'),'control_origin_chat':c.get('origin_chat'),
        'control_source_message_id':c.get('evidence_message_id'),'resumes_control_id':c.get('resumes_control_id')}
    if any(ev.get(k)!=v for k,v in expected.items()): return False
    prior=task_of(d,ev['root_request_id'],ev['task_id'],ev['origin_chat'],c['task_version']) or {}
    if not any(x.get('applied') and local_control_release(origin,x) for x in prior.get('events',[])): return False
    cursor=ev['origin_chat']; seen=set()
    while cursor:
        if cursor in seen: return False
        seen.add(cursor); s=read_state(cursor) or {}; active=task_control_for(s,ev['task_id'],ev['origin_chat'])
        if active.get('state')=='paused': return False
        cursor=s.get('parent')
    return True
def apply_event(st, ev, received_at, source_chat, source_message_id=None, downstream_rejections=None):
    """Record one event. Returns (changed, applied, reason). Caller holds ChatLock."""
    downstream_rejections=validate_rejections(ev,[] if downstream_rejections is None else downstream_rejections)
    d=delegation(st); key=event_key(ev['root_request_id'],ev['task_id'],ev['origin_chat']); store=task_store(d,ev['task_id'],ev['task_version']); t=store.get(key)
    if t is None:
        t={'root_request_id':ev['root_request_id'],'task_id':ev['task_id'],'origin_chat':ev['origin_chat'],'task_version':ev['task_version'],
           'state':'unknown','applied_event_version':0,'last_occurred_at':None,'last_received_at':None,
           'parent_chat':st.get('parent'),'events':[],'sync_status':'local'}; store[key]=t
    if t.get('root_request_id')!=ev['root_request_id'] or t.get('task_id')!=ev['task_id']:
        raise RuntimeError('task key collision')
    prior=next((x for x in t['events'] if x.get('event_id')==ev['event_id']),None)
    if prior:
        if not same_event(prior,ev): raise RuntimeError('event_id collision/mutation')
        if prior.get('downstream_rejections',[])!=downstream_rejections:
            raise RuntimeError('event rejection provenance changed after landing')
        return False,False,'duplicate'
    rec=dict(ev); rec.update({'source_chat':source_chat,'source_message_id':source_message_id,
                              'received_at':received_at,'landed_at':ts(),'applied':False})
    if downstream_rejections: rec['downstream_rejections']=list(downstream_rejections)
    reason=''; applied=False; cur_tver=int(t.get('task_version') or 0); cur_ever=int(t.get('applied_event_version') or 0)
    control=task_control_for(st,ev['task_id'],ev['origin_chat'])
    released=committed_release_receipt(st,ev) if ev['event_type']=='pause_released' else False
    resumed=committed_resumption(st,ev) if ev['event_type']=='resumed' else False
    if downstream_rejections: reason='rejected_downstream'
    elif ev['event_type']=='pause_released' and not released: reason='release_requires_bound_control'
    elif ev['event_type']=='resumed' and not resumed: reason='resume_requires_bound_control'
    elif control.get('state')=='paused' and ev['event_type']!='paused': reason='paused_no_reactivation'
    elif control.get('state')=='released' and ev['task_version']<control.get('resume_task_version',0) and not released: reason='released_requires_new_task_version'
    elif t.get('state')=='resume_pending' and ev['task_version']<=cur_tver and not released: reason='released_requires_new_task_version'
    elif ev['task_version']<cur_tver: reason='stale_task_version'
    elif ev['task_version']==cur_tver and ev['event_version']<cur_ever: reason='out_of_order'
    elif ev['task_version']==cur_tver and ev['event_version']==cur_ever and cur_ever!=0: reason='version_conflict'
    elif t.get('state')=='paused' and ev['event_type']!='resumed' and not released and not same_control_pause_receipt(st,ev): reason='paused_no_reactivation'
    elif version_event_guard(st,ev): reason=version_event_guard(st,ev)
    elif ev['event_type']=='resumed' and ev['origin_chat']==st['chat_id'] and t.get('state')!='accepted': reason='resume_requires_fresh_acceptance'
    elif t.get('state') in ('completed','failed'): reason='terminal_no_reactivation'
    elif ev['event_type']=='review_passed' and t.get('state')!='pending_review': reason='review_requires_pending_result'
    elif ev['task_version']==cur_tver and ev['event_type'] in ('accepted','queued') and t.get('state') not in ('unknown','accepted','queued'): reason='stage_regression'
    else:
        t['task_version']=ev['task_version']; t['state']=EVENT_TYPES[ev['event_type']][0]
        t['applied_event_version']=ev['event_version']; t['last_occurred_at']=ev['occurred_at']; t['last_received_at']=received_at
        applied=True; rec['applied']=True
    if reason: rec['reject_reason']=reason
    # Do not discard the dedup history: an old event outside a rolling window
    # must not become a fresh event after enough milestones.
    t['events'].append(rec)
    st['delegation']=d
    return True,applied,reason
def queue_bubble(st, ev):
    if not st.get('parent'): return False
    lc=lifecycle_of(st); out=lc['bubbles'].setdefault('out',[])
    rejection_chain=rejections_for(st,ev)
    existing=[x for x in out if x.get('kind')=='task_event' and x.get('event_id')==ev['event_id']]
    if len(existing)>1: raise RuntimeError('duplicate task event bubble')
    if existing:
        b=existing[0]
        if not same_event(b.get('event',{}),ev): raise RuntimeError('bubble event mutation')
        if b.get('rejections',[])==rejection_chain: return False
        if b.get('state')!='pending' or b.get('attempts') or b.get('sending_at') or b.get('sent_message_id'):
            raise RuntimeError('cannot rewrite rejection provenance after send attempt')
        b['rejections']=rejection_chain; b['rejection_upgraded_at']=ts()
        st['lifecycle']=lc
        return True
    bubble={'kind':'task_event','event_id':ev['event_id'],'event':dict(ev),'rejections':rejection_chain,
                'state':'pending','pending_at':ts(),'attempts':0}
    if ev.get('source_report') is not None:
        path=(cfg().get('delegation_auto') or {}).get('allowed_path',[])
        if st['chat_id'] not in path: raise RuntimeError('summary node outside configured path')
        tier=('root' if st['chat_id']==path[0] else 'near' if st['chat_id']==path[-1] else 'middle')
        # Own acceptance may have just changed in this same uncommitted state.
        # Use the locked postimage, not the previous on-disk binding.
        lookup=lambda ch,t,v:task_binding(st if ch==st['chat_id'] else read_state(ch),t,v)
        summary=p5summary.build(st,ev['task_id'],tier,lookup)
        p5summary.validate_projection(summary,p5summary.build(st,ev['task_id'],tier,lookup))
        bubble['summary']=summary
        bubble['summary_sha256']=csha(summary)
    out.append(bubble)
    st['lifecycle']=lc
    d=delegation(st); t=task_of(d,ev['root_request_id'],ev['task_id'],ev['origin_chat'],ev['task_version'])
    if is_current_event(t,ev): t['sync_status']='pending'; st['delegation']=d
    return True
def validate_event(ev):
    if ev.get('source_report') is not None: p5summary.validate_report(ev['source_report'])
    for k in ('root_request_id','task_id','event_type','occurred_at','origin_chat','evidence_message_id'):
        if not isinstance(ev.get(k),str) or not ev[k]: raise ValueError(f'missing {k}')
    if ev['event_type'] not in EVENT_TYPES: raise ValueError('unknown event_type')
    if type(ev.get('task_version')) is not int or ev['task_version']<1: raise ValueError('invalid task_version')
    if type(ev.get('event_version')) is not int or ev['event_version']<1: raise ValueError('invalid event_version')
    parse_time(ev['occurred_at'])
    want=event_id(ev['root_request_id'],ev['task_id'],ev['task_version'],ev['event_version'],ev['origin_chat'],ev['event_type'],ev['evidence_message_id'])
    if ev.get('event_id')!=want: raise ValueError('event_id mismatch')

def cmd_emit(a,source_report=None):
    chat,root,task,tver,ever,etype,occurred,evidence=a
    if etype=='pause_released': raise RuntimeError('release events can only derive from an exact committed recovery control')
    st=read_state(chat); ok,why=managed_state(st)
    if not ok: raise RuntimeError(f'chat not managed: {why}')
    require_trial(st)
    if root!=delegation_identity()[0]: raise RuntimeError('event root outside this task trial')
    binding=task_binding(st,task)
    if not binding or binding.get('root_request_id')!=root or binding.get('task_version')!=int(tver):
        raise RuntimeError('no exact task delivery binding; transport ack is not task acceptance')
    if not task_of(delegation(st),root,task,chat) and etype!='accepted':
        raise RuntimeError('origin must record real task acceptance before progress')
    ev={'root_request_id':root,'task_id':task,'task_version':int(tver),'event_version':int(ever),
        'event_type':etype,'occurred_at':occurred,'origin_chat':chat,'evidence_message_id':evidence}
    if etype=='resumed':
        c=(st.get('delegation') or {}).get('controls',{}).get(task,{})
        ev.update(derived_from_control=c.get('control_id'),control_origin_chat=c.get('origin_chat'),
            control_source_message_id=c.get('evidence_message_id'),resumes_control_id=c.get('resumes_control_id'))
    if source_report is not None: ev['source_report']=source_report
    ev['event_id']=event_id(root,task,int(tver),int(ever),chat,etype,evidence); validate_event(ev)
    good,why=source_evidence(chat,ev)
    if not good: raise RuntimeError('evidence rejected: '+why)
    with ChatLock(chat):
        st=read_state(chat); require_trial(st)
        if (task_binding(st,task) or {})!=binding:
            raise RuntimeError('task binding changed during evidence verification')
        ctrl=(delegation(st).get('controls') or {}).get(task) or {}
        if ctrl.get('state')=='paused' and etype!='paused':
            raise RuntimeError('task paused; late evidence cannot reactivate task')
        changed,applied,reason=apply_event(st,ev,ts(),chat,evidence)
        if applied and etype=='accepted':
            task_binding(st,task).update({'acceptance_status':'accepted','accepted_message_id':evidence,'accepted_at':occurred})
        if applied or (source_report is not None and changed): queue_bubble(st,ev)
        write_state(chat,st)
    print(json.dumps({'event_id':ev['event_id'],'changed':changed,'applied':applied,'reason':reason},ensure_ascii=False))

def cmd_resumed_source(chat,root,task,ever):
    st=read_state(chat); require_trial(st); binding=task_binding(st,task) or {}
    c=(st.get('delegation') or {}).get('controls',{}).get(task,{})
    ev={'root_request_id':root,'task_id':task,'task_version':binding.get('task_version'),'event_version':int(ever),
        'event_type':'resumed','origin_chat':chat,'derived_from_control':c.get('control_id'),
        'control_origin_chat':c.get('origin_chat'),'control_source_message_id':c.get('evidence_message_id'),
        'resumes_control_id':c.get('resumes_control_id')}
    row=task_of(delegation(st),root,task,chat,binding.get('task_version')) or {}
    if not committed_resumption(st,ev) or row.get('state')!='accepted' or int(ever)<=row.get('applied_event_version',0):
        raise RuntimeError('resumed source requires landed release and fresh accepted generation')
    print(root+' '+task+' '+encode_marker({'task_event_source':ev}))

def cmd_import_legacy_receipt(child,task,eid,mid):
    """Reconcile a pre-migration accepted event without notifying it twice."""
    cs=read_state(child); require_trial(cs); parent=cs.get('parent'); ps=read_state(parent) or {}
    if (task_binding(cs,task) or {}).get('migration_id'): raise RuntimeError('legacy receipt import is closed after explicit version migration')
    t=task_of(delegation(cs),delegation_identity()[0],task,child)
    ev=next((e for e in (t or {}).get('events',[]) if e.get('event_id')==eid),None)
    if not ev or ev.get('event_type')!='accepted': raise RuntimeError('only a verified historical acceptance may be imported')
    old=(ps.get('tasks') or {}).get(task) or {}
    expected={'rootRequestId':delegation_identity()[0],'taskbook_version':ev['task_version'],'child_chat_id':child,'accepted_message_id':ev['evidence_message_id'],'child_report_message_id':mid}
    if any(old.get(k)!=v for k,v in expected.items()): raise RuntimeError('parent legacy receipt does not bind exact task/source/report')
    msgs=list_messages(parent,start=now()-datetime.timedelta(hours=48)); m=next((m for m in msgs if m.get('message_id')==mid),None)
    if not m or m.get('chat_id')!=parent or m.get('sender',{}).get('sender_type')!='app' or m['sender']['id'] not in set(role_apps_for(cs).values()): raise RuntimeError('legacy report target/sender not verified')
    mentions=m.get('mentions') or []; allowed={executor_app(ps),observer_app()}
    if not exact_single_mention(m,allowed): raise RuntimeError('legacy report lacks exact parent receiver')
    txt=message_body(m)
    if any(x not in txt for x in (delegation_identity()[0],task,ev['evidence_message_id'])): raise RuntimeError('legacy report body does not bind acceptance source')
    with AuthLocks(parent,child):
        ps=read_state(parent) or {}; cs=read_state(child); require_trial(cs)
        current=(ps.get('tasks') or {}).get(task) or {}
        if any(current.get(k)!=v for k,v in expected.items()) or cs.get('parent')!=parent or child not in ps.get('children',[]): raise RuntimeError('legacy receipt/topology changed during verification')
        lc=lifecycle_of(cs)
        hits=[b for b in lc['bubbles']['out'] if b.get('kind')=='task_event' and b.get('event_id')==eid]
        if len(hits)!=1 or hits[0].get('state') not in ('pending','imported_legacy'): raise RuntimeError('cannot replace a new-path send attempt')
        hits[0].update({'state':'imported_legacy','legacy_message_id':mid,'imported_at':ts(),'no_new_notification':True})
        branch=task_of(delegation(cs),delegation_identity()[0],task,child)
        branch['sync_status']='legacy_parent_landed'; branch['legacy_report_message_id']=mid
        branch['legacy_parent_observed_at']=current.get('observed_at')
        cs['delegation']['bindings'][task].update({'acceptance_status':'accepted','accepted_message_id':ev['evidence_message_id'],'accepted_at':ev['occurred_at']})
        cs['lifecycle']=lc; write_state(child,cs)
    print(json.dumps({'imported':True,'event_id':eid,'legacy_message_id':mid,'new_send_count':0}))

def receipt_for(child,event_id_,mid):
    cst=read_state(child)
    if not cst or cst.get('parent') is None: return None,'child state missing parent'
    hits=[b for b in lifecycle_of(cst)['bubbles'].get('out',[]) if b.get('kind')=='task_event' and b.get('event_id')==event_id_]
    if len(hits)!=1: return None,f'child bubble count {len(hits)}'
    b=hits[0]
    if b.get('state')!='sent' or b.get('sent_message_id')!=mid: return None,'child sent receipt not committed'
    ev=b.get('event') or {}
    t=task_of(delegation(cst),ev.get('root_request_id'),ev.get('task_id'),ev.get('origin_chat'),ev.get('task_version'))
    records=[r for r in (t or {}).get('events',[]) if r.get('event_id')==event_id_]
    if len(records)!=1 or not same_event(records[0],ev): return None,'child source event not committed or mutated'
    try: verify_bubble_rejections(cst,b)
    except Exception as e: return None,str(e)
    return b,''

def cmd_ingest(parent,scope=None):
    pst=read_state(parent); ok,why=managed_state(pst)
    if not ok: raise RuntimeError(f'parent not managed: {why}')
    require_trial(pst)
    children=set(pst.get('children') or [])
    if scope: children.intersection_update(scope['allowed_path'])
    since=now()-datetime.timedelta(hours=48)
    receipt_ids=set()
    for child in children:
        cs=read_state(child)
        if not cs or cs.get('parent')!=parent: continue
        for b in lifecycle_of(cs)['bubbles']['out']:
            if b.get('kind')!='task_event' or b.get('state')!='sent': continue
            if scope and not in_scope(b.get('event',{}),scope): continue
            receipt_ids.add(b.get('sent_message_id'))
            # An outage has no 48-hour expiry. Scan back to the oldest
            # unacknowledged durable receipt, only on registered child edges.
            if not b.get('parent_landed_at'):
                since=min(since,parse_time(b['pending_at'])-datetime.timedelta(minutes=10))
    msgs=list_messages(parent,start=since); results=[]
    for m in sorted(msgs,key=msg_time):
        # A card with no committed child receipt cannot advance this protocol.
        # Avoid reading unrelated work cards (and their private view links).
        if m.get('msg_type') in ('interactive','post') and m.get('message_id') not in receipt_ids: continue
        sender=m.get('sender',{})
        for mk in find_markers(message_body(m)):
            if not mk.get('task_event'): continue
            if scope and not in_scope(mk,scope): continue
            child=mk.get('source_chat'); eid=mk.get('task_event'); row={'event_id':eid,'message_id':m.get('message_id'),'source_chat':child}
            if sender.get('sender_type')!='app': row['result']='reject_sender'; results.append(row); continue
            if child not in children: row['result']='reject_foreign_subtree'; results.append(row); continue
            cst=read_state(child)
            if not cst or cst.get('parent')!=parent: row['result']='reject_topology'; results.append(row); continue
            b,bwhy=receipt_for(child,eid,m['message_id'])
            if not b: row['result']='unresolved_receipt'; row['why']=bwhy; results.append(row); continue
            ev=b.get('event') or {}
            if ev.get('root_request_id')!=delegation_identity()[0]: row['result']='reject_wrong_root'; results.append(row); continue
            try: validate_event(ev)
            except Exception as e: row['result']='reject_event'; row['why']=str(e); results.append(row); continue
            if event_marker(ev,child,b.get('rejections',[]),b.get('summary'))!=mk: row['result']='reject_marker_mismatch'; results.append(row); continue
            if b.get('summary') is not None and csha(b['summary'])!=b.get('summary_sha256'):
                row['result']='reject_summary_digest'; results.append(row); continue
            if not exact_event_message(m,ev,child): row['result']='reject_noncanonical_message'; results.append(row); continue
            with ChatLock(parent):
                st=read_state(parent)
                if child not in (st.get('children') or []) or (read_state(child) or {}).get('parent')!=parent:
                    raise RuntimeError('topology changed before local event commit')
                changed,applied,reason=apply_event(st,ev,ts(),child,m['message_id'],b.get('rejections',[]))
                # A valid historical source must reach every ancestor even
                # when a newer event landed first here. Relay it as an audit
                # fact without advancing state. Also repair a prior crash (or
                # old implementation) that committed the event but missed its
                # queue entry; bubble event_id dedup prevents a second send.
                queue_bubble(st,ev)
                write_state(parent,st)
                committed=task_of(delegation(read_state(parent)),ev['root_request_id'],ev['task_id'],ev['origin_chat'],ev['task_version'])
                rec=next(x for x in committed['events'] if x.get('event_id')==eid)
                landed=rec['landed_at']
            # Receipt means the parent actually stored the source event, not
            # merely that the send API accepted a message. A duplicate ingest
            # repairs a crash between parent commit and this acknowledgement.
            with ChatLock(child):
                cs=read_state(child); clc=lifecycle_of(cs)
                for bubble in clc['bubbles']['out']:
                    if bubble.get('kind')=='task_event' and bubble.get('event_id')==eid:
                        bubble['parent_landed_at']=landed; bubble['parent_landed_chat']=parent
                cs['lifecycle']=clc
                ct=task_of(delegation(cs),ev['root_request_id'],ev['task_id'],ev['origin_chat'],ev['task_version'])
                if is_current_event(ct,ev):
                    ct['sync_status']='parent_landed'; ct['parent_landed_at']=landed
                write_state(child,cs)
            row.update({'result':'applied' if applied else reason,'changed':changed}); results.append(row)
    print(json.dumps({'ingested':results},ensure_ascii=False))

def in_scope(ev,scope):
    return (ev.get('root_request_id')==scope['root_request_id'] and ev.get('task_id')==scope['task_id']
            and ev.get('origin_chat') in scope['allowed_path'])

def cmd_flush(child,scope=None):
    st=read_state(child); ok,why=managed_state(st)
    if not ok: raise RuntimeError(f'child not managed: {why}')
    require_trial(st)
    parent=st.get('parent'); done=[]
    if not parent: print(json.dumps({'flushed':[]})); return
    if scope and parent not in scope['allowed_path']: raise RuntimeError('parent outside automatic scope')
    pst=read_state(parent)
    if not managed_state(pst)[0] or child not in (pst.get('children') or []):
        for b in lifecycle_of(st)['bubbles']['out']:
            if b.get('kind')=='task_event' and b.get('state') in ('pending','sending'):
                sync_failure(child,b['event'],'parent unavailable/unmanaged or child not registered')
        raise RuntimeError('parent unavailable/unmanaged or child not registered; pending events retained')
    ob=p_outbox(child); os.makedirs(ob,exist_ok=True); self_filtered_target=None
    for cur in [x for x in lifecycle_of(read_state(child))['bubbles'].get('out',[]) if x.get('kind')=='task_event' and x.get('state') in ('pending','sending') and (not scope or in_scope(x.get('event',{}),scope))]:
        eid=cur['event_id']; ev=cur['event']; validate_event(ev); acquire=os.path.join(ob,'event-'+eid+'.lock')
        fd=os.open(acquire,os.O_RDWR|os.O_CREAT,0o644); fcntl.flock(fd,fcntl.LOCK_EX)
        try:
            live=read_state(child)
            current=[x for x in lifecycle_of(live)['bubbles']['out'] if x.get('kind')=='task_event' and x.get('event_id')==eid]
            if len(current)!=1: raise RuntimeError('event bubble missing/duplicate')
            cur=current[0]
            if cur.get('state')=='sent': continue
            if not same_event(cur['event'],ev): raise RuntimeError('event changed while waiting for send lock')
            verify_bubble_rejections(live,cur)
            if cur.get('summary') is not None and csha(cur['summary'])!=cur.get('summary_sha256'):
                raise RuntimeError('summary changed after queue; no send')
            if live.get('parent')!=parent or child not in ((read_state(parent) or {}).get('children') or []): raise RuntimeError('event topology drift')
            if not cur.get('route'):
                route=report_route(child,parent)
                with ChatLock(child):
                    s=read_state(child); lc=lifecycle_of(s)
                    for b in lc['bubbles']['out']:
                        if b.get('kind')=='task_event' and b.get('event_id')==eid: b['route']=route
                    s['lifecycle']=lc; write_state(child,s)
                cur['route']=route
            rcpt=os.path.join(ob,'event-'+eid+'.sent'); found=None
            boundary=parse_time(cur['pending_at'])-datetime.timedelta(minutes=10)
            # Query before any resend, including after a crash with no .sent
            # receipt. A query failure stops the flush with the queue intact.
            try: matches=[m for m in list_messages(parent,start=boundary) if exact_event_message(m,ev,child)]
            except Exception as e:
                sync_failure(child,ev,e); raise
            if matches:
                matches.sort(key=msg_time); found=matches[0]['message_id']
            if not found:
                if cur.get('state')=='sending':
                    raise RuntimeError('previous report send outcome unknown; retain receipt reconciliation, do not blindly resend')
                summary=event_text(ev,child,cur.get('rejections',[]),cur.get('summary'))
                with ChatLock(child):
                    s=read_state(child); lc=lifecycle_of(s)
                    for b in lc['bubbles']['out']:
                        if b.get('kind')=='task_event' and b.get('event_id')==eid and b.get('state')=='pending': b['state']='sending'; b['sending_at']=ts(); b['attempts']=int(b.get('attempts') or 0)+1
                    s['lifecycle']=lc; write_state(child,s)
                try:
                    if report_route(child,parent)!=cur['route']: raise RuntimeError('report sender/target route changed before send')
                    mid=send_report(cur['route'],summary)
                    if not mid: raise RuntimeError('event send returned no message_id')
                    check=next((m for m in list_messages(parent,start=boundary) if m.get('message_id')==mid),None)
                    if not check or check.get('chat_id')!=parent or not exact_event_message(check,ev,child):
                        raise RuntimeError('event send not verified on exact parent/message/sender/body: '+mid)
                    found=mid
                except Exception as e:
                    with ChatLock(child):
                        s=read_state(child); lc=lifecycle_of(s)
                        for b in lc['bubbles']['out']:
                            if b.get('kind')=='task_event' and b.get('event_id')==eid: b['last_error']=str(e); b['last_error_at']=ts()
                        d=delegation(s); t=task_of(d,ev['root_request_id'],ev['task_id'],ev['origin_chat'],ev['task_version'])
                        if is_current_event(t,ev): t['sync_status']='retry_pending'; t['sync_error']=str(e); s['delegation']=d
                        s['lifecycle']=lc; write_state(child,s)
                    raise
            atomic_write(rcpt,json.dumps({'message_id':found,'at':ts(),'source_chat':child,'target_chat':parent,'event_id':eid,'event_sha':csha(ev)}).encode())
            with ChatLock(child):
                s=read_state(child); lc=lifecycle_of(s)
                for b in lc['bubbles']['out']:
                    if b.get('kind')=='task_event' and b.get('event_id')==eid: b['state']='sent'; b['sent_message_id']=found; b['sent_at']=ts(); b.pop('last_error',None)
                d=delegation(s); t=task_of(d,ev['root_request_id'],ev['task_id'],ev['origin_chat'],ev['task_version'])
                if t:
                    if is_current_event(t,ev):
                        t['sync_status']='sent_unconfirmed'; t['sync_error']=None
                    for x in t.get('events',[]):
                        if x.get('event_id')==eid: x['forwarded_message_id']=found; x['forwarded_at']=ts()
                    s['delegation']=d
                s['lifecycle']=lc; write_state(child,s)
            done.append({'event_id':eid,'message_id':found})
            if cur['route'].get('self_filtered'): self_filtered_target=cur['route']['target_app']
        finally: fcntl.flock(fd,fcntl.LOCK_UN); os.close(fd)
    # One nudge per flush, not per event: the parent only needs to be told once
    # that something is waiting. A failed nudge must not undo landed receipts —
    # the reports are already sent and verified — so report it and exit nonzero.
    woke=None
    if done and self_filtered_target:
        try: woke=wake_parent(parent,self_filtered_target,len(done))
        except Exception as e:
            print(json.dumps({'flushed':done,'woke':None,'wake_error':str(e)},ensure_ascii=False))
            raise SystemExit(8)
    print(json.dumps({'flushed':done,'woke':woke},ensure_ascii=False))

def cmd_status(chat,root,task):
    st=read_state(chat) or {}
    branches=[t for t in task_store(delegation(st),task).values() if t.get('root_request_id')==root and t.get('task_id')==task]
    for t in branches:
        at=t.get('last_received_at')
        t['observation']='last_known'
        t['stale']=not at or (now()-parse_time(at)).total_seconds()>CHILD_STALE_SEC
    control=(delegation(st).get('controls') or {}).get(task)
    pending=[{'kind':b.get('kind'),'target':b.get('target') or st.get('parent'),'event_id':b.get('event_id'),'state':b.get('state'),'sync_error':b.get('sync_error') or b.get('last_error')} for b in lifecycle_of(st)['bubbles']['out'] if b.get('kind') in ('task_event','task_control') and b.get('state') in ('pending','sending')]
    scoped_controls=[c for c in delegation(st).get('branch_controls',{}).values() if c.get('task_id')==task]
    binding=task_binding(st,task) or {}
    active={k:binding.get(k) for k in ('task_version','migration_id','delivery_message_id','acceptance_status','accepted_message_id','accepted_at')}
    print(json.dumps({'chat':chat,'active_binding':active,'branches':branches,'local_task_state':(st.get('tasks') or {}).get(task),'task_control':control,'branch_controls':scoped_controls,'pending_sync':pending},ensure_ascii=False,indent=2))

def main():
    if len(sys.argv)<2: raise SystemExit(__doc__)
    op=sys.argv[1]
    try:
        if op=='emit' and len(sys.argv)==10: cmd_emit(sys.argv[2:])
        elif op=='resumed-source' and len(sys.argv)==6: cmd_resumed_source(*sys.argv[2:])
        elif op=='ingest' and len(sys.argv)==3: cmd_ingest(sys.argv[2])
        elif op=='flush' and len(sys.argv)==3: cmd_flush(sys.argv[2])
        elif op=='reconcile-sent' and len(sys.argv)==8: cmd_reconcile_sent(*sys.argv[2:])
        elif op=='status' and len(sys.argv)==5: cmd_status(*sys.argv[2:])
        elif op=='import-legacy-receipt' and len(sys.argv)==6: cmd_import_legacy_receipt(*sys.argv[2:])
        else: raise RuntimeError('bad arguments')
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False)); raise SystemExit(9)
if __name__=='__main__': main()
