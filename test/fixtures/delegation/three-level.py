#!/usr/bin/env python3
"""Exercise installed protocol with a local transport; NOT a live Lark claim."""
import json, os, subprocess, sys
from pathlib import Path
home=Path(sys.argv[1]); fixture=Path(sys.argv[2]); p5=home/'cost-opt/p5'
env=dict(os.environ,P5_HOME=str(home),P5_CONFIG=str(p5/'p5-config.json'),P5_BOTMUX_BIN=str(fixture),P5_LARK_BIN=str(fixture),
         DELEGATION_FIXTURE_MESSAGES=str(home/'fixture-messages.json'),P5_NOW='2026-01-01T10:05:00+08:00',BOTMUX_HOME=str(home/'botmux-fixture'),
         SESSION_DATA_DIR=str(home/'botmux-fixture/data'),BOTMUX_LARK_APP_ID='cli_executor',BOTMUX_SESSION_ID='fixture-root',PYTHONDONTWRITEBYTECODE='1')
env.pop('BOTMUX_LARK_APP_SECRET',None)
os.environ.update(env); sys.path.insert(0,str(p5))
from p5lib import encode_marker, task_binding, read_state
records=[]
def run(args,extra=None):
    p=subprocess.run(args,env=dict(env,**(extra or {})),text=True,capture_output=True)
    records.append({'argv':args,'rc':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
    if p.returncode: raise RuntimeError(json.dumps(records[-1],ensure_ascii=False))
    return p.stdout.strip()
cli=os.environ.get('DELEGATION_CLI_BIN')
def command(sub,*args):
    return run(['node',cli,'delegation',sub,'--home',str(home),*map(str,args)])
def tool(name,*args,extra=None):
    if cli:
        key={'p5-task-binding.py':'binding','p5-task-event.py':'event','p5-decision.py':'decision'}[name]
        return command('run',key,*args)
    return run(['python3',str(p5/name),*map(str,args)],extra)
def post(chat,body,who='app'): return run([str(fixture),'fixture','post',chat,body,who])
conf=json.loads((p5/'p5-config.json').read_text()); chats=conf['version_migration']['allowed_path']; task=conf['version_migration']['task_id']
data=Path(env['SESSION_DATA_DIR']); data.mkdir(parents=True)
sessions={f'fixture-{i}':{'sessionId':f'fixture-{i}','chatId':ch,'larkAppId':'cli_executor','status':'active'} for i,ch in enumerate(chats)}
(data/'sessions-cli_executor.json').write_text(json.dumps(sessions))
root=post(chats[0],f'Please execute task {task} along this three-node chain.','user')
assert root==conf['version_migration']['root_request_id']
for chat in chats:
    if cli: command('node','--chat',chat)
    else: run(['python3',str(home/'bin/delegation-node.py'),chat])
tool('p5-task-binding.py','intake-root',chats[0],root,task,1,root)
def accept(chat,delivery):
    mid=post(chat,f'accepted root={root} task={task} task_version=1 delivery_message_id={delivery}')
    m=next(m for m in json.loads(Path(env['DELEGATION_FIXTURE_MESSAGES']).read_text()) if m['message_id']==mid)
    obj=json.loads(tool('p5-task-event.py','emit',chat,root,task,1,1,'accepted',m['create_time'],mid))
    assert obj['applied']
accept(chats[0],root)
deliveries=[]
for parent,child in zip(chats,chats[1:]):
    book=home/f'{parent}-new.md'
    book.write_text(f'# {task}\n- node READY kind=worker role=worker created=2026-01-01 09:59 next={child}:{task}\n')
    announcement=json.loads(command('run','taskbook',parent,str(book)) if cli else run(['bash',str(p5/'taskbook-write.sh'),parent,str(book)]))
    basis_mid=post(parent,encode_marker({'node':'READY','round':1,'role':'worker','verdict':'done'}))
    basis={'kind':'bot_message','ref':basis_mid,'node':'READY','round':1,'role':'worker','verdict':'done','taskbook_sha':announcement['sha'],'taskbook_gen':announcement['gen']}
    body=home/f'{parent}-delivery.txt'; body.write_text(f'root={root} task={task} task_version=1\nPerform the assigned example and report upstream.\n')
    basis_file=home/f'{parent}-basis.json'; basis_file.write_text(json.dumps(basis))
    if cli: command('dispatch','--from',parent,'--to',child,'--basis',basis_file,'--body',body)
    else: run(['python3',str(home/'bin/delegation-command.py'),'dispatch',parent,child,str(basis_file),str(body)])
    sent=read_state(parent)['lifecycle']['decisions']['out'][-1]['sent_message_id']; deliveries.append(sent)
    tool('p5-task-binding.py','bind',child,root,task,1,sent); accept(child,sent)
leaf=chats[-1]
semantic_rejections=[]
if os.environ.get('DELEGATION_FIXTURE_BAD_EVENT_FIELDS'):
    noise=os.environ.get('DELEGATION_FIXTURE_PROSE','')
    for field,bad in [('task_version',99),('event_type','failed'),('origin_chat',chats[0])]:
        source={'root_request_id':root,'task_id':task,'task_version':1,'event_version':2,
                'event_type':'result_pending_review','origin_chat':leaf}
        source[field]=bad
        bad_mid=post(leaf,f'root={root} task={task} '+noise+'\n'+encode_marker({'task_event_source':source}))
        m=next(m for m in json.loads(Path(env['DELEGATION_FIXTURE_MESSAGES']).read_text()) if m['message_id']==bad_mid)
        before={p.name:p.read_bytes() for p in (home/'webroot').glob('*.json')}
        argv=['python3',str(p5/'p5-task-event.py'),'emit',leaf,root,task,'1','2','result_pending_review',m['create_time'],bad_mid]
        rejected=subprocess.run(argv,env=env,text=True,capture_output=True)
        record={'field':field,'argv':argv,'rc':rejected.returncode,'stdout':rejected.stdout,'stderr':rejected.stderr}
        assert rejected.returncode==9 and 'event source envelope mismatch' in rejected.stdout,record
        assert before=={p.name:p.read_bytes() for p in (home/'webroot').glob('*.json')}
        semantic_rejections.append(record)
marker=command('source','--chat',leaf,'--type','result_pending_review','--event-version','2') if cli else run(['python3',str(home/'bin/delegation-command.py'),'source',leaf,'result_pending_review','2'])
mid=post(leaf,f'Example result is ready for review. root={root} task={task} '+marker)
m=next(m for m in json.loads(Path(env['DELEGATION_FIXTURE_MESSAGES']).read_text()) if m['message_id']==mid)
result=json.loads(tool('p5-task-event.py','emit',leaf,root,task,1,2,'result_pending_review',m['create_time'],mid)); assert result['applied']
if os.environ.get('DELEGATION_FIXTURE_PAUSE_BEFORE_FLUSH'):
    print(json.dumps({'setup_ready':True,'commands':records}));sys.exit(0)
if os.environ.get('DELEGATION_FIXTURE_PROSE'):
    for parent in chats[:-1]:
        post(parent,os.environ['DELEGATION_FIXTURE_PROSE'])
report_mentions=[];wakes=[]
for child,parent in zip(reversed(chats[1:]),reversed(chats[:-1])):
    flushed=json.loads(tool('p5-task-event.py','flush',child))
    posted=json.loads(Path(env['DELEGATION_FIXTURE_MESSAGES']).read_text())
    for row in flushed['flushed']:
        sent=next(x for x in posted if x['message_id']==row['message_id'])
        # Every hop must wake the parent's own executor, not a bystander.
        report_mentions.append({'child':child,'parent':parent,'mentions':[y.get('id') for y in (sent.get('mentions') or [])]})
    # Same app on both ends here, so each flush must also nudge from another app.
    woke=next(x for x in posted if x['message_id']==flushed['woke'])
    wakes.append({'parent':parent,'sender':woke['sender']['id'],'chat':woke['chat_id'],
                  'mentions':[y.get('id') for y in (woke.get('mentions') or [])],'has_marker':'[p5:' in woke['content']})
    tool('p5-task-event.py','ingest',parent)
for chat in chats:
    status=json.loads(tool('p5-task-event.py','status',chat,root,task))
    row=next(t for t in status['branches'] if t['origin_chat']==leaf)
    assert row['state']=='pending_review',row
print(json.dumps({'ok':True,'transport':'local-fixture','live_lark_verified':False,'downstream_deliveries':deliveries,'result_source':mid,'all_three_nodes':'pending_review','report_mentions':report_mentions,'wakes':wakes,'commands':records,'semantic_rejections':semantic_rejections},ensure_ascii=False))
