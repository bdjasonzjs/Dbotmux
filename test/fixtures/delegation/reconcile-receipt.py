#!/usr/bin/env python3
"""Reproduce an actual failed send in local transport, then reconcile, never resend."""
import json,os,pathlib,subprocess,sys
home=pathlib.Path(sys.argv[1]);transport=pathlib.Path(sys.argv[2]);p5=home/'cost-opt/p5'
env=dict(os.environ,P5_HOME=str(home),P5_CONFIG=str(p5/'p5-config.json'),P5_BOTMUX_BIN=str(transport),P5_LARK_BIN=str(transport),
 DELEGATION_FIXTURE_MESSAGES=str(home/'fixture-messages.json'),P5_NOW='2026-01-01T10:05:00+08:00',BOTMUX_HOME=str(home/'botmux-fixture'),
 SESSION_DATA_DIR=str(home/'botmux-fixture/data'),BOTMUX_LARK_APP_ID='cli_executor',BOTMUX_SESSION_ID='fixture-root',PYTHONDONTWRITEBYTECODE='1')
env.pop('BOTMUX_LARK_APP_SECRET',None);os.environ.update(env);sys.path.insert(0,str(p5))
from p5lib import canonical,csha,read_state,task_binding
records=[]
def run(argv,rc=0,extra=None):
 p=subprocess.run(argv,env=dict(env,**(extra or {})),capture_output=True,text=True)
 rec={'argv':argv,'rc':p.returncode,'stdout':p.stdout,'stderr':p.stderr};records.append(rec)
 assert p.returncode==rc,rec
 return p.stdout.strip()
run(['python3',str(pathlib.Path(__file__).with_name('three-level.py')),str(home),str(transport)],extra={'DELEGATION_FIXTURE_PAUSE_BEFORE_FLUSH':'1'})
cfg=json.loads((p5/'p5-config.json').read_text());root,child,leaf=cfg['version_migration']['allowed_path']
task=cfg['version_migration']['task_id'];messages=pathlib.Path(env['DELEGATION_FIXTURE_MESSAGES'])
def event(*args,rc=0,extra=None):return run(['python3',str(p5/'p5-task-event.py'),*args],rc,extra)
def bubbles():return read_state(child)['lifecycle']['bubbles']['out']
def business_files():
 return {str(p.relative_to(home)):p.read_bytes() for name in ['webroot','outbox','journal'] for p in (home/name).rglob('*') if p.is_file() and p.suffix!='.lock'}
def message_count():return len(json.loads(messages.read_text()))
error=event('flush',child,rc=9,extra={'DELEGATION_FIXTURE_DROP_MENTION':'1'})
assert 'event send not verified on exact parent/message/sender/body' in error,error
b=next(b for b in bubbles() if b.get('kind')=='task_event');ev=b['event'];mid=json.loads(messages.read_text())[-1]['message_id']
assert b['state']=='sending' and mid in b['last_error'] and not b.get('sent_message_id')
assert not json.loads(messages.read_text())[-1]['mentions']
unresolved=json.loads(event('ingest',root))
assert any(x['result']=='unresolved_receipt' for x in unresolved['ingested']),unresolved
confirmation=f'I read the delivered message {mid}; this is the expected event. Keep its original body and do not resend.'
# The confirming reader is the parent's executor — the same app the report mentions.
cmid=run([str(transport),'fixture','post',root,confirmation,'app','cli_executor'])
import hashlib
args=['reconcile-sent',child,ev['event_id'],csha(ev),mid,cmid,hashlib.sha256(confirmation.encode()).hexdigest()]
before=business_files();count=message_count()
wrong=list(args);wrong[4]='om_wrong_receipt';event(*wrong,rc=9)
assert before==business_files() and count==message_count()
wrong_sha=list(args);wrong_sha[3]='0'*64
assert 'reconciliation event sha256 mismatch' in event(*wrong_sha,rc=9)
assert before==business_files() and count==message_count()
saved=messages.read_bytes();ms=json.loads(saved)
original=next(m for m in ms if m['message_id']==mid)
original['rendered_content']=original['content'];original['content']+=' changed'
messages.write_text(json.dumps(ms))
assert 'reconciliation original body differs from committed event' in event(*args,rc=9)
assert before==business_files() and count==message_count();messages.write_bytes(saved)
ms=json.loads(saved);next(m for m in ms if m['message_id']==mid)['deleted']=True
messages.write_text(json.dumps(ms))
assert 'reconciliation original message deleted' in event(*args,rc=9)
assert before==business_files() and count==message_count();messages.write_bytes(saved)
# Display rendering may differ; only the unchanged raw body is compared.
ms=json.loads(saved);next(m for m in ms if m['message_id']==mid)['rendered_content']='display only'
messages.write_text(json.dumps(ms))
first=json.loads(event(*args));assert first['changed'] and first['external_sends']==0 and not first['parent_landed'],first
b2=next(x for x in bubbles() if x.get('event_id')==ev['event_id'])
assert b2['state']=='sent' and b2['sent_message_id']==mid and not b2.get('parent_landed_at')
assert b2['event']==ev and b2['receipt_reconciliation']['previous_error']==b['last_error']
assert b2['receipt_reconciliation']['delivery_mode']=='reconciled_without_mention'
assert b2['receipt_reconciliation']['original_readback']=={'deleted':False,'msg_type':'text','body_source':'rawContent.text'}
after=business_files();repeat=json.loads(event(*args))
assert not repeat['changed'] and after==business_files() and count==message_count(),repeat
event('flush',child);assert count==message_count()
ingest=json.loads(event('ingest',root))
assert any(x['event_id']==ev['event_id'] and x['result']=='applied' for x in ingest['ingested']),ingest
landed=next(x for x in bubbles() if x.get('event_id')==ev['event_id']);assert landed['parent_landed_at']
after=business_files();repeat_after_landing=json.loads(event(*args))
assert not repeat_after_landing['changed'] and repeat_after_landing['parent_landed']
assert after==business_files() and count==message_count()
print(json.dumps({'ok':True,'initial_failed_send_rc':9,'zero_duplicate_external_sends':True,
 'wrong_message_rejected':True,'wrong_body_rejected':True,'wrong_sha_rejected':True,'deleted_message_rejected':True,
 'raw_body_not_rendered_body':True,'explicit_missing_mention_audit':True,'repeated_reconcile_zero_state_writes':True,
 'parent_ingest_applied':True,'live_lark_verified':False,'commands':records}))
