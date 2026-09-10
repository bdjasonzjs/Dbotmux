#!/usr/bin/env python3
"""Unwired, default-off automatic callback: tick <chat>; disable.

One invocation belongs to one node. A future authorized round-end/event adapter
calls tick; parents run their own callbacks, never a child's recursive root run.
All transport uses task-event/control's existing outbox. No scheduler or service
is installed here. Saves workers/observers manually invoking emit/ingest/flush.
"""
import contextlib, importlib.util, io, json, os, sys, fcntl, copy
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
import p5summary

MANUAL_LATCH=os.path.join(P5_HOME,'health','delegation-auto-manual.json')

def auto_scope():
    conf=delegation_scope('delegation_auto')
    # This adapter remains the existing root / middle / implementation path.
    # IDs move to config; the excluded fourth acceptance branch does not join it.
    if len(conf['allowed_path'])!=3:
        raise RuntimeError('automatic root/task/path requires the three-node callback scope')
    return conf

def scope_ids():
    conf=auto_scope()
    return conf['root_request_id'],conf['task_id'],conf['allowed_path']

def module(name):
    spec=importlib.util.spec_from_file_location(name,os.path.join(os.path.dirname(__file__),name+'.py'))
    mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

def gate(chat):
    conf=auto_scope()
    if conf.get('enabled') is not True: return None
    if os.path.exists(MANUAL_LATCH): return None  # A local stop can never grant authority.
    if chat not in conf['allowed_path']: raise RuntimeError('chat outside automatic allowlist (paused acceptance branch excluded)')
    if os.environ.get('P5_DELEGATION_TRIAL_ROOT'):
        raise RuntimeError('legacy trial hook and new callback must not run together')
    datetime.datetime.strptime(conf.get('not_before',''),'%Y-%m-%d %H:%M:%S')
    return conf

@contextlib.contextmanager
def auto_lock(blocking=True):
    p=os.path.join(P5_HOME,'locks','delegation-auto.lock'); os.makedirs(os.path.dirname(p),exist_ok=True)
    fd=os.open(p,os.O_CREAT|os.O_RDWR,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|(0 if blocking else fcntl.LOCK_NB)); yield
    finally: os.close(fd)

def validate_node(chat,allow_unaccepted=False):
    ROOT,TASK,PATH=scope_ids()
    i=PATH.index(chat); st=read_state(chat)
    if not managed_state(st)[0] or st.get('chat_id')!=chat: raise RuntimeError('automatic node not exactly managed')
    if st.get('parent')!=(PATH[i-1] if i else None): raise RuntimeError('automatic parent drift')
    if i<len(PATH)-1 and PATH[i+1] not in st.get('children',[]): raise RuntimeError('automatic registered edge missing')
    b=task_binding(st,TASK) or {}
    statuses=('accepted','awaiting_real_acceptance') if allow_unaccepted else ('accepted',)
    if b.get('root_request_id')!=ROOT or b.get('acceptance_status') not in statuses:
        raise RuntimeError('automatic requires provisioned binding and real acceptance before business work')
    if i:
        ps=read_state(PATH[i-1]) or {}; pb=task_binding(ps,TASK) or {}
        if chat not in ps.get('children',[]) or pb.get('task_version')!=b.get('task_version') or pb.get('acceptance_status')!='accepted':
            raise RuntimeError('automatic parent binding/edge mismatch')
    return st

def record_status(chat,status,error=None):
    ROOT,TASK,PATH=scope_ids()
    # A visible blocked mark + ledger is the charter alarm alternative. This
    # is health, NOT a forged business blocked event or a second notification.
    with ChatLock(chat):
        s=read_state(chat); d=s.setdefault('delegation',{}); previous=d.get('auto_status') or {}
        d['auto_status']={'state':status,'at':ts(),'error':error,'parent_chat':s.get('parent'),
            'last_known_only':True,'root_request_id':ROOT,'task_id':TASK}
        write_state(chat,s)
    if error and (previous.get('state'),previous.get('error'))!=(status,error):
        ledger_line(chat,'A1 同步受阻（父执行者可查；原状态/outbox保留）：'+error)

def project(chat):
    ROOT,TASK,PATH=scope_ids()
    with ChatLock(chat):
        st=read_state(chat); tier='root' if chat==PATH[0] else 'near' if chat==PATH[-1] else 'middle'
        result=p5summary.build(st,TASK,tier,lambda ch,t,v:task_binding(read_state(ch),t,v))
        result['sync_health']={ch:(read_state(ch).get('delegation') or {}).get('auto_status',{'state':'unknown'})
            for ch in st.get('children',[]) if ch in PATH}
        result['guard_health']={ch:(read_state(ch).get('delegation') or {}).get('guard_status',{'state':'unknown'})
            for ch in st.get('children',[]) if ch in PATH}
        # Parent-side observation stays in the existing local ledger/state.
        # An unchanged blocked observation must not notify on every tick.
        seen=st['delegation'].setdefault('health_observations',{})
        for kind in ('sync_health','guard_health'):
            for child,health in result[kind].items():
                key=kind+':'+child; digest=csha([health.get('state'),health.get('error'),health.get('command')])
                if health.get('state')=='blocked' and seen.get(key)!=digest:
                    marker='health_observation='+csha([key,digest])
                    ledger=p_ledger(chat)
                    if not os.path.exists(ledger) or marker not in open(ledger,encoding='utf-8').read():
                        ledger_line(chat,'直属子节点 '+child+' 同步/守卫受阻；保留最后已知状态：'+str(health.get('error'))+' '+marker)
                seen[key]=digest
        st['delegation'].setdefault('summaries',{})[TASK]=result
        write_state(chat,st)
    return result

def prefetch_source_bodies(messages, role_apps):
    """Bound card hydration to eight reads without changing scan order.

    The P5 reader still verifies every card through quoted_message and its
    original _reader_app_id.  This only overlaps independent reads; later
    collect() consumes the original ordered snapshot and turns a per-message
    read failure into that source's existing rejection record.
    """
    cards=[m for m in messages
           if m.get('msg_type') in ('interactive','post')
           and m.get('sender',{}).get('sender_type')=='app'
           and m.get('sender',{}).get('id') in role_apps]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for offset in range(0,len(cards),8):
            batch=cards[offset:offset+8]
            jobs=[pool.submit(quoted_message,m) for m in batch]
            for m,job in zip(batch,jobs):
                try:
                    q=job.result(); m['_auto_source_body']=q.get('content') or ''
                except Exception as ex:
                    m['_auto_source_error']=str(ex)

def collect(chat,conf,E):
    ROOT,TASK=conf['root_request_id'],conf['task_id']
    st=read_state(chat); binding=task_binding(st,TASK); found=[]; failures=[]
    start=E.parse_time(conf['not_before'])
    messages=sorted(list_messages(chat,start=start),key=msg_time)
    prefetch_source_bodies(messages,set(role_apps_for(st).values()))
    def one(m):
        # Only source envelopes can emit progress. Session cards, ordinary
        # status prose and the bot's own forwarded events are not acceptances.
        sender=m.get('sender',{}); roles=role_apps_for(st)
        if sender.get('sender_type')!='app' or sender.get('id') not in set(roles.values()): return
        if '_auto_source_error' in m: raise RuntimeError('automatic source readback failed: '+m['_auto_source_error'])
        body=m.get('_auto_source_body') if '_auto_source_body' in m else E.message_body(m)
        markers=find_markers(body)
        sources=[x['task_event_source'] for x in markers if 'task_event_source' in x]
        if not sources: return
        if len(sources)!=1: raise RuntimeError('ambiguous automatic source envelope')
        src=sources[0]
        if not isinstance(src,dict) or src.get('root_request_id')!=ROOT or src.get('task_id')!=TASK or src.get('origin_chat')!=chat: return
        if src.get('event_type') not in E.EVENT_TYPES: raise RuntimeError('unknown automatic event type')
        if type(src.get('task_version')) is not int or type(src.get('event_version')) is not int: raise RuntimeError('invalid source versions')
        if src['task_version']!=binding['task_version']:
            # Old/future source text is never re-emitted into a new binding.
            found.append({'message_id':m['message_id'],'result':'inactive_source_version'}); return
        eid=E.event_id(ROOT,TASK,src['task_version'],src['event_version'],chat,src['event_type'],m['message_id'])
        row=E.task_of(E.delegation(read_state(chat)),ROOT,TASK,chat,src['task_version']) or {}
        if any(e.get('event_id')==eid for e in row.get('events',[])): return
        reports=[x['task_report'] for x in markers if 'task_report' in x]
        if len(reports)!=1: raise RuntimeError('automatic source needs one full task_report; no inferred delivery verdict')
        report=p5summary.validate_report(reports[0])
        occurred=msg_time(m).strftime('%Y-%m-%d %H:%M:%S')
        out=io.StringIO()
        with contextlib.redirect_stdout(out):
            E.cmd_emit([chat,ROOT,TASK,str(src['task_version']),str(src['event_version']),src['event_type'],occurred,m['message_id']],source_report=report)
        result=json.loads(out.getvalue()); found.append(result)
        if not result.get('applied') and result.get('reason')!='duplicate':
            failures.append({'message_id':m['message_id'],'error':'automatic source rejected: '+result.get('reason','unknown')})
    for m in messages:
        try: one(m)
        except Exception as ex:
            failures.append({'message_id':m['message_id'],'error':str(ex)})
            # Keep the source failure visible without starving other valid
            # messages or previously committed control/event receipts.
    return {'collected':found,'rejected_sources':failures}

def tick(chat):
    conf=gate(chat)
    if conf is None: return {'enabled':False,'steps':[],'note':'disabled: zero state or external I/O'}
    with auto_lock(False):
        conf=gate(chat)
        if conf is None: return {'enabled':False,'steps':[]}
        validate_node(chat,allow_unaccepted=True)
        E=module('p5-task-event'); C=module('p5-task-control'); steps=[]; source_failures=[]
        try:
            # Local callback only, no cross-node recursion. Pause ingestion
            # precedes progress; parent commit always precedes upward flush.
            for name,fn in [('control-ingest',lambda:C.ingest(chat,conf)),
                            ('source-collect',lambda:collect(chat,conf,E)),
                            ('event-ingest',lambda:E.cmd_ingest(chat,conf)),
                            ('project',lambda:project(chat)),
                            ('control-flush',lambda:C.flush(chat,conf)),
                            ('event-flush',lambda:E.cmd_flush(chat,conf))]:
                if gate(chat)!=conf: raise RuntimeError('automatic configuration changed during callback')
                validate_node(chat,allow_unaccepted=name in ('control-ingest','source-collect'))
                out=io.StringIO()
                with contextlib.redirect_stdout(out): value=fn()
                if name=='source-collect': source_failures=value['rejected_sources']
                steps.append({'step':name,'result':value,'output':out.getvalue()})
                if name in ('event-ingest','control-ingest'):
                    receipts=json.loads(out.getvalue()).get('ingested',[])
                    failures=[r for r in receipts if r.get('result')=='unresolved_receipt' or str(r.get('result','')).startswith('reject_')]
                    if failures: raise RuntimeError('unconfirmed/rejected transport receipt: '+canonical(failures))
            if source_failures: raise RuntimeError('source validation blocked: '+canonical(source_failures))
            record_status(chat,'healthy'); summary=project(chat)
            return {'enabled':True,'steps':steps,'summary':summary,'whole_task_complete':False}
        except Exception as ex:
            record_status(chat,'blocked',str(ex)); project(chat)
            raise

def disable():
    # Own stop latch, not a read/modify/write of the shared P5 config: another
    # task's concurrent config edit cannot be clobbered by this rollback.
    # The shared callback lock drains in-flight work before returning manual.
    conf=auto_scope()
    with auto_lock():
        conf=auto_scope()
        if os.path.exists(MANUAL_LATCH) or conf.get('enabled') is not True:
            return {'enabled':False,'changed':False}
        latch={'root_request_id':conf['root_request_id'],'task_id':conf['task_id'],'mode':'manual','disabled_at':ts()}
        atomic_write(MANUAL_LATCH,(json.dumps(latch,ensure_ascii=False,indent=2)+'\n').encode())
        if json.load(open(MANUAL_LATCH))!=latch: raise RuntimeError('disable latch readback failed')
        return {'enabled':False,'changed':True,'state_and_outbox':'untouched','mode':'manual'}

def main():
    try:
        if len(sys.argv)==3 and sys.argv[1]=='tick': result=tick(sys.argv[2])
        elif sys.argv[1:]==['disable']: result=disable()
        else: raise RuntimeError('use tick <chat> or disable; no enable command')
        print(json.dumps(result,ensure_ascii=False))
    except BlockingIOError:
        print(json.dumps({'queued':True,'retry_required':True,'reason':'callback already active; caller must retry, not success'}))
        raise SystemExit(75)
    except Exception as ex:
        try: ROOT,TASK,PATH=scope_ids()
        except Exception: ROOT,TASK,PATH=None,None,[]  # Missing config has no writable task target.
        if len(sys.argv)==3 and sys.argv[1]=='tick' and sys.argv[2] in PATH:
            chat=sys.argv[2]; s=read_state(chat)
            if managed_state(s)[0] and (s.get('delegation') or {}).get('root_request_id')==ROOT:
                record_status(chat,'blocked',str(ex))
        print(json.dumps({'ok':False,'error':str(ex),'whole_task_complete':False},ensure_ascii=False)); raise SystemExit(9)
if __name__=='__main__': main()
