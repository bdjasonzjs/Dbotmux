"""Explicit, task-scoped approval renewal; no sends and no synthetic acceptance.

The original plan hash remains the migration identity. A changed deadline is
effective only with a committed, independently approved renewal receipt. State
files share the normal authorization locks; a write-ahead receipt fences crash
interruption until explicit recovery restores the exact before-images.
"""
import copy, importlib.util, json, pathlib
import p5lib as L
from p5lib import *

def version():
    s=importlib.util.spec_from_file_location('renewal_version',pathlib.Path(__file__).with_name('p5-task-version.py'))
    v=importlib.util.module_from_spec(s); s.loader.exec_module(v); return v

def proposal(r):
    return {'task_version_renewal_proposal':{'request':r,'request_sha256':csha(r),
        'operation':'renew-approval','authority':'existing_task_engineering'}}

def review(r,mid):
    return {'task_version_renewal_review':{'request_sha256':csha(r),'migration_id':r['migration_id'],
        'renewal_version':r['renewal_version'],'proposal_message_id':mid,'verdict':'PASS',
        'operation':'renew-approval','runtime_enable':False}}

def expected(chat,new_plan):
    v=version(); p=v.validate_plan(copy.deepcopy(new_plan)); v.gated(p); path=v.topology(p)
    if chat!=path[0]: raise RuntimeError('renewal requires exact originating root')
    root=task_binding(read_state(chat),v.migration_scope()['task_id']) or {}; old=root.get('version_plan')
    if not old or root.get('delivery_kind')!='version_delegated_engineering':
        raise RuntimeError('renewal requires original delegated engineering authority; owner intake is not downgraded')
    if root.get('authorization',{}).get('kind')!='original_mandate_and_independent_change_review':
        raise RuntimeError('original independent engineering approval missing')
    want=copy.deepcopy(old); want['expires_at']=p['expires_at']
    if p!=want: raise RuntimeError('renewal may change expires_at only')
    if p['expires_at']<=old['expires_at']: raise RuntimeError('renewal deadline must strictly increase')
    history=root.get('approval_renewals') or []; mid=root.get('migration_id')
    if history: validate_approval_renewals(root); v.predecessors(old,mid)
    else:
        if csha(old)!=mid: raise RuntimeError('original migration hash differs from original plan')
        v.predecessors(old)
    targets=[]; suffix=False
    for i,ch in enumerate(path):
        v.not_paused(p,ch)
        for ancestor in path[:i+1]:
            c=task_control_for(read_state(ancestor),v.migration_scope()['task_id'],ch)
            if (c.get('state')=='released' and p['to_version']<c.get('resume_task_version',0)) or int(c.get('task_version') or 0)>p['to_version']:
                raise RuntimeError('renewal cannot overtake control version at '+ancestor)
        st=read_state(ch); b=task_binding(st,v.migration_scope()['task_id']) or {}
        if open_claims(ch): raise RuntimeError('in-flight dispatch claim; retry after original operation settles: '+ch)
        if b.get('migration_id')==mid:
            if suffix: raise RuntimeError('migration bindings must be a contiguous prefix')
            if (b.get('task_version')!=p['to_version'] or b.get('version_plan')!=old
                    or (b.get('approval_renewals') or [])!=history or b.get('acceptance_status')!='accepted'):
                raise RuntimeError('bound migration plan/history/acceptance differs: '+ch)
            targets.append(ch)
            if i+1<len(path):
                why=task_chain_guard(ch,path[i+1],v.migration_scope()['task_id'],{'root_request_id':v.migration_scope()['root_request_id'],'task_id':v.migration_scope()['task_id'],
                    'task_version':b['task_version'],'parent_delivery_id':b['delivery_message_id']})
                if why and why!='version approval expired; retain history, do not dispatch':
                    raise RuntimeError('renewal preserves chain guard: '+why)
        else:
            suffix=True
            if b.get('task_version')!=p['from_version'] or b.get('acceptance_status')!='accepted':
                raise RuntimeError('unbound suffix lacks accepted predecessor: '+ch)
    return {'root_request_id':v.migration_scope()['root_request_id'],'task_id':v.migration_scope()['task_id'],'migration_id':mid,'plan':p,
        'old_expires_at':old['expires_at'],'new_expires_at':p['expires_at'],'targets':targets,
        'renewal_version':len(history)+1,'previous_renewal_id':history[-1]['renewal_id'] if history else None}

def request(chat,file): return expected(chat,json.loads(pathlib.Path(file).read_text()))

def publish_state(chat,st):
    # Preserve the common state writer. Preflight excludes active claims and
    # renewal does not alter lifecycle, so this cannot emit ancillary journals.
    L.write_state(chat,st)

def save_receipt(rid,tx): atomic_write(p_approval_renewal(rid),(canonical(tx)+'\n').encode())

def restore(tx):
    # Compare EVERY node before writing ANY node: never overwrite intervening
    # observer/business changes after a crashed process releases its locks.
    for ch,row in tx['images'].items():
        raw=pathlib.Path(p_state(ch)).read_bytes()
        if sha256b(raw) not in {row['before_sha256'],row['after_sha256']}:
            raise RuntimeError('renewal recovery refuses unrelated state drift: '+ch)
    for ch,row in tx['images'].items():
        raw=bytes.fromhex(row['before_hex'])
        if sha256b(raw)!=row['before_sha256']: raise RuntimeError('corrupt renewal before-image')
    for ch,row in tx['images'].items(): atomic_write(p_state(ch),bytes.fromhex(row['before_hex']))

def renew(chat,file,proposal_mid,review_mid,sid,app):
    r=json.loads(pathlib.Path(file).read_text()); v=version()
    if not isinstance(r,dict) or type(r.get('renewal_version')) is not int:
        raise RuntimeError('renewal_version must be an integer, not a boolean')
    p=v.validate_plan(r.get('plan')); v.gated(p); path=v.topology(p)
    if chat!=path[0]: raise RuntimeError('renewal only at original root')
    control=v.module('p5-task-control'); ident=control.caller_reader(chat,sid,app)
    rid=csha({'request':r,'proposal_message_id':proposal_mid,'review_message_id':review_mid})
    receipt=pathlib.Path(p_approval_renewal(rid))
    with AuthLocks(*path):
        if receipt.exists():
            tx=json.loads(receipt.read_text())
            if tx.get('phase')=='committed' and tx.get('request')==r:
                # No new authority is granted by replay. All former targets
                # must still carry the original committed receipt.
                for ch in r['targets']:
                    b=task_binding(read_state(ch),v.migration_scope()['task_id']) or {}; validate_approval_renewals(b)
                    if tx['audit'] not in b.get('approval_renewals',[]): raise RuntimeError('duplicate renewal target drift')
                return {'renewed':False,'duplicate':True,'renewal_id':rid}
            raise RuntimeError('renewal receipt exists; pending requires renewal-recover, aborted requires new approval')
        if r!=expected(chat,p): raise RuntimeError('renewal request/targets differ from exact bound migration')
        before={ch:pathlib.Path(p_state(ch)).read_bytes() for ch in path}
        cfg_sha=csha(load_config())
    # No state locks across network I/O. All before-images and authority are
    # rechecked under the same ordered locks before publication.
    root=task_binding(json.loads(before[chat]),v.migration_scope()['task_id'])
    anchors=root.get('change_sources') or {}
    # Re-read historical cited sources at their committed timestamps. Their age
    # does not expire the mandate; only the NEW proposal/PASS must be fresh.
    since=min(datetime.datetime.fromtimestamp(int(anchors[mid]['created_at'])/1000,BJ)
        for mid in p['change_evidence_ids'])-datetime.timedelta(seconds=1)
    authority,sources=v.verify_engineering_authority(chat,p,proposal_mid,review_mid,ident,proposal(r),review(r,proposal_mid),since)
    for mid in p['change_evidence_ids']:
        if (sha256b(sources[mid]['content'].encode())!=anchors[mid]['body_sha256']
                or str(sources[mid]['createTime'])!=str(anchors[mid]['created_at'])):
            raise RuntimeError('original approved change source changed: '+mid)
    if any(len(MARK_RE.findall(sources[mid]['content']))!=1 for mid in (proposal_mid,review_mid)):
        raise RuntimeError('renewal requires one exact proposal and approval marker')
    prior=(root.get('approval_renewals') or [])
    prior_at=(prior[-1]['approved_at'] if prior else root['delivery_at'])
    if int(sources[proposal_mid]['createTime'])<int(prior_at): raise RuntimeError('renewal proposal precedes prior approval')
    audit={k:copy.deepcopy(r[k]) for k in ('root_request_id','task_id','migration_id','renewal_version',
        'previous_renewal_id','old_expires_at','new_expires_at','targets')}
    audit.update(renewal_id=rid,request_sha256=csha(r),authorization=authority,approved_at=sources[review_mid]['createTime'],
        evidence={k:{'message_id':k,'body_sha256':sha256b(q['content'].encode()),'created_at':q['createTime']} for k,q in sources.items()})
    with AuthLocks(*path):
        if (csha(load_config())!=cfg_sha or control.caller_reader(chat,sid,app)!=ident
                or any(pathlib.Path(p_state(ch)).read_bytes()!=raw for ch,raw in before.items())):
            raise RuntimeError('renewal authority/state/reader drift during approval readback')
        if r!=expected(chat,p): raise RuntimeError('renewal scope changed before commit')
        if receipt.exists(): raise RuntimeError('concurrent renewal receipt; retry exact request for duplicate result')
        images={}; states={}
        for ch in r['targets']:
            st=json.loads(before[ch]); b=task_binding(st,v.migration_scope()['task_id'])
            b['version_plan']['expires_at']=r['new_expires_at']
            b.setdefault('approval_renewals',[]).append(copy.deepcopy(audit))
            after=json.dumps(st,ensure_ascii=False,indent=1).encode()
            states[ch]=st; images[ch]={'before_hex':before[ch].hex(),'before_sha256':sha256b(before[ch]),'after_sha256':sha256b(after)}
        tx={'schema_version':1,'phase':'preparing','root_chat':chat,'request':r,'audit':audit,'images':images,'created_at':ts()}
        save_receipt(rid,tx)
        try:
            for ch,st in states.items(): publish_state(ch,st)
            for ch,row in images.items():
                if sha256b(pathlib.Path(p_state(ch)).read_bytes())!=row['after_sha256']: raise RuntimeError('renewal postimage mismatch: '+ch)
            tx['phase']='committed'; tx['committed_at']=ts(); save_receipt(rid,tx)
        except Exception:
            restore(tx); tx['phase']='aborted'; tx['aborted_at']=ts(); save_receipt(rid,tx)
            raise
    return {'renewed':True,'renewal_id':rid,'migration_id':r['migration_id'],'renewal_version':r['renewal_version'],
        'updated_nodes':r['targets'],'new_expires_at':r['new_expires_at'],'dispatches':0,'acceptances':'not_synthesized'}

def recover(chat,rid,sid,app):
    """Recover an interrupted batch only to its exact before-images, never grant time."""
    v=version(); control=v.module('p5-task-control'); ident=control.caller_reader(chat,sid,app)
    f=pathlib.Path(p_approval_renewal(rid)); tx=json.loads(f.read_text()); r=tx['request']; path=r['plan']['path']
    v.gated(r['plan']); v.topology(r['plan'])
    if chat!=path[0] or tx['root_chat']!=chat or ident['app_id']!=tx['audit']['authorization']['executor_app']:
        raise RuntimeError('recovery requires original root executor')
    if (rid!=csha({'request':r,'proposal_message_id':tx['audit']['authorization']['proposal_message_id'],
                 'review_message_id':tx['audit']['authorization']['review_message_id']})
            or set(tx['images'])!=set(r['targets']) or any(ch not in path for ch in r['targets'])):
        raise RuntimeError('recovery transaction identity/scope differs')
    with AuthLocks(*path):
        if json.loads(f.read_text())!=tx or control.caller_reader(chat,sid,app)!=ident: raise RuntimeError('recovery transaction/reader drift')
        if tx['phase']=='aborted': return {'recovered':False,'duplicate':True,'renewal_id':rid}
        if tx['phase']!='preparing': raise RuntimeError('committed renewal cannot be rolled back by recovery')
        if any(open_claims(ch) for ch in path): raise RuntimeError('in-flight dispatch prevents recovery')
        restore(tx); tx['phase']='aborted'; tx['aborted_at']=ts(); tx['recovered_by']=ident; save_receipt(rid,tx)
    return {'recovered':True,'renewal_id':rid,'restored_nodes':r['targets'],'new_authority_granted':False}
