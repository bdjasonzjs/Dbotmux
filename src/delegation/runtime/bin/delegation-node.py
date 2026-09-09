#!/usr/bin/env python3
"""Initialize one existing chat as a node; do not send, invite or accept tasks."""
import copy, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../cost-opt/p5'))
from p5lib import *

def main(chat):
    conf=cfg(); scope=delegation_scope('version_migration'); path=scope['allowed_path']
    if chat not in path: raise RuntimeError('chat not in configured path')
    node=(conf.get('nodes') or {}).get(chat)
    if not node or not node.get('executor_ou'): raise RuntimeError('config missing: nodes[chat].executor_ou')
    if node['parent'] and not read_state(node['parent']): raise RuntimeError('initialize parent first: '+node['parent'])
    reader=transport_readers()[0]
    argv=[LARK_BIN,'im','+chat-members-list','--chat-id',chat,'--member-types','user,bot','--member-id-type','open_id','--page-all','--page-limit','0','--profile',reader['profile'],'--as',reader['as']]
    rc,out,err=run(argv,timeout=120)
    if rc: raise RuntimeError('member readback failed rc='+str(rc)+' '+err[:200])
    response=parse_json_tail(out); data=response.get('data') or {}
    if response.get('ok') is False or data.get('chat_id')!=chat: raise RuntimeError('member readback returned another chat or failed')
    owner=owner_id_for_app(reader['app_id'])
    if not owner or not any(m.get('member_id')==owner for m in data.get('users',[])):
        raise RuntimeError('owner not present in member readback; no invitation performed: '+chat+' reader='+reader['app_id'])
    bots=data.get('bots',[])
    for app in {executor_app(), observer_app()}:
        if not any(m.get('app_id')==app for m in bots): raise RuntimeError('required bot not present: '+str(app))
    proof={'reader_app':reader['app_id'],'profile':reader['profile'],'owner_open_id':owner,'read_at':ts(),'members_sha256':csha(data)}
    # Read existing policy. Absence means no instant observer has been enabled;
    # initialization never installs a schedule or edits botmux policy files.
    policy_file=p_policies()
    policies=json.load(open(policy_file)) if os.path.isfile(policy_file) else {'policies':[]}
    matching=[p for p in policies.get('policies',[]) if p.get('chatId')==chat]
    instant='on' if any((p.get('instantObserver') or {}).get('enabled') for p in matching) else 'off'
    with ChatLock(chat):
        existing=read_state(chat)
        if existing:
            if existing.get('parent')!=node['parent'] or existing.get('children')!=node['children'] or existing.get('executor_ou')!=node['executor_ou']:
                raise RuntimeError('node already exists with different topology/actor; not overwritten')
            print(json.dumps({'ok':True,'duplicate':True,'chat':chat,'member_readback':proof})); return
        lc=copy.deepcopy(DEFAULT_LIFECYCLE); lc['status_changed_at']=ts(); lc['wake']['instant']=instant
        state={'schema_version':4,'chat_id':chat,'group':chat,'type':node['type'],
               'parent':node['parent'],'children':node['children'],'executor_ou':node['executor_ou'],
               'paused':False,'lifecycle':lc,'taskbook_version':0,'tasks':{},'logs':[],'notes':[],
               'p5_managed':{'source':'bootstrap','at':ts(),'via':'botmux delegation node','member_readback':proof}}
        ok,why=managed_state(state)
        if not ok: raise RuntimeError(why)
        atomic_write(os.path.join(P5_HOME,'health','node-members-'+short(chat)+'.json'),canonical({'command':argv,'rc':rc,'response':response,'read_at':ts()}).encode())
        write_state(chat,state)
    append_fsync(os.path.join(P5_HOME,'node-initialization.jsonl'),{'chat':chat,'command':argv,'rc':rc,'member_readback':proof,'at':ts()})
    print(json.dumps({'ok':True,'chat':chat,'parent':node['parent'],'children':node['children'],'acceptance':'not_synthesized','member_readback':proof},ensure_ascii=False))

if __name__=='__main__':
    try:
        if len(sys.argv)!=2: raise RuntimeError('usage: delegation-node.py <chat_id>')
        main(sys.argv[1])
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error)},ensure_ascii=False)); sys.exit(9)
