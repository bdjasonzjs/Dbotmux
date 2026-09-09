#!/usr/bin/env python3
"""CLI conveniences; dispatch still has exactly one P5 proposal/send path."""
import json, os, re, subprocess, sys
from pathlib import Path
p5=Path(__file__).resolve().parent.parent/'cost-opt/p5'
sys.path.insert(0,str(p5))
from p5lib import *

def call(args,env=None):
    result=subprocess.run([sys.executable,str(p5/'p5-decision.py'),*args],env=env,text=True,capture_output=True)
    if result.returncode:
        sys.stdout.write(result.stdout); sys.stderr.write(result.stderr); sys.exit(result.returncode)
    return result.stdout

def main(args):
    root,task=delegation_identity()
    if args[0]=='dispatch' and len(args)==5:
        _,parent,child,basis_file,body_file=args
        binding=task_binding(read_state(parent),task)
        if not binding: raise RuntimeError('parent has no task binding; run intake/bind and record real acceptance first')
        basis=json.loads(Path(basis_file).read_text())
        child_state=read_state(child) or {}; executor=child_state.get('executor_ou')
        if not executor: raise RuntimeError('child has no initialized executor')
        chain={'root_request_id':root,'task_id':task,'task_version':binding['task_version'],'parent_delivery_id':binding['delivery_message_id']}
        output=call(['propose',parent,child,task,json.dumps(basis),executor,body_file],dict(os.environ,P5_CHAIN_META_JSON=json.dumps(chain)))
        did=output.strip()
        if not re.fullmatch('[a-f0-9]{64}',did): raise RuntimeError('proposal returned no exact decision_id: '+output)
        print(json.dumps({'decision_id':did,'phase':'proposed','next_if_interrupted':'delegation run decision dispatch '+parent+' '+did}),flush=True)
        print(call(['dispatch',parent,did]),end='')
        entries=lifecycle_of(read_state(parent))['decisions']['out']
        entry=next(e for e in entries if e['decision_id']==did)
        print(json.dumps({'decision_id':did,'state':entry['state'],'sent_message_id':entry.get('sent_message_id'),'acceptance':'not_synthesized'}))
    elif args[0]=='source' and len(args)==4:
        _,chat,event_type,version=args
        allowed={'queued','started','milestone','blocked','result_pending_review','review_passed','failed'}
        if event_type not in allowed: raise RuntimeError('use accepted or control-specific source entry for this event type')
        binding=task_binding(read_state(chat),task)
        if not binding: raise RuntimeError('source node has no task binding')
        ev=int(version)
        if ev<1: raise RuntimeError('event-version must be a positive integer')
        print(encode_marker({'task_event_source':{'root_request_id':root,'task_id':task,'task_version':binding['task_version'],'event_version':ev,'event_type':event_type,'origin_chat':chat}}))
    else: raise RuntimeError('usage: dispatch <parent> <child> <basis.json> <body.txt> | source <chat> <type> <event_version>')

if __name__=='__main__':
    try: main(sys.argv[1:])
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error)},ensure_ascii=False)); sys.exit(9)
