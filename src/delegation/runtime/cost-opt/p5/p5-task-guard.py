#!/usr/bin/env python3
"""Fail-closed guards; spawn-create holds branch locks through the create call."""
import sys,os,datetime,json
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from p5lib import *
def chain_registered_child(ps,chat):
    """父侧已登记指向该子群的任务链边（tasks[*].child_chat_id / delegation bindings / branch_controls）→ 子群即使尚无 delegation 也属委派分支。"""
    for v in (ps.get('tasks') or {}).values():
        if isinstance(v,dict) and v.get('child_chat_id')==chat and v.get('rootRequestId'): return True
    d=ps.get('delegation') or {}
    for b in (d.get('bindings') or {}).values():
        if isinstance(b,dict) and chat in (b.get('child_chat_id'),b.get('target_child')): return True
    for vs in (d.get('task_versions') or {}).values():
        for e in ((vs or {}).get('versions') or {}).values():
            b=(e or {}).get('binding') or {}
            if chat in (b.get('child_chat_id'),b.get('target_child')): return True
    for c in (d.get('branch_controls') or {}).values():
        if isinstance(c,dict) and c.get('target_child')==chat: return True
    # 父侧 outbox 里任何指向该子群的链路决策（含已取消/已发）= 该子群已是链路目标
    lc=ps.get('lifecycle') if isinstance(ps.get('lifecycle'),dict) else {}
    for e in ((lc.get('decisions') or {}).get('out') or []):
        if not isinstance(e,dict): continue
        b=e.get('basis') or {}
        if chat in (e.get('child'),e.get('child_chat'),e.get('target'),b.get('edge_child')): return True
    # 父侧任一任务链处于 paused：暂停期间不得从该父群发出任何新派单
    for c in (d.get('controls') or {}).values():
        if isinstance(c,dict) and c.get('state')=='paused': return True
    return False
def legacy(chat,executor):
    cs=read_state(chat)
    if not cs or cs.get('chat_id')!=chat: raise RuntimeError('unknown target registration')
    parent=cs.get('parent'); ps=read_state(parent) if parent else None
    if not ps or chat not in ps.get('children',[]): raise RuntimeError('unregistered parent/child edge')
    # 只在「子群本身已纳入 P5/委派试运行」时才退役 legacy；
    # 父群仅因试运行而带 lifecycle/delegation 不能把非试运行的叶全部堵死（本节点因此空转 5 天）。
    # lifecycle 只是 P5 节流记账（当前 dry-run），不是派单契约；只有纳入委派试运行（delegation）的子群才必须走 --p5。
    if cs.get('delegation') or chain_registered_child(ps,chat):
        raise RuntimeError('legacy dispatch retired for delegation-enrolled child; use --p5-chain/--p5')
    reg=cs.get('executor_ou')
    if reg and reg!=executor: raise RuntimeError('executor differs from target instance')
    if not reg:
        tpl=os.path.join(P5_HOME,'templates',f"{cs.get('type') or 'dev-squad'}.md")
        if os.path.exists(tpl) and executor not in open(tpl,encoding='utf-8').read():
            raise RuntimeError('executor not in type template role table')
def target(chat,executor,mid):
    cs=read_state(chat) or {}
    reg=cs.get('executor_ou')
    if reg and reg!=executor: raise RuntimeError('executor registration drift')
    if not reg:   # 未登记 executor_ou 的老叶按类型模板角色表核
        tpl=os.path.join(P5_HOME,'templates',f"{cs.get('type') or 'dev-squad'}.md")
        if os.path.exists(tpl) and executor not in open(tpl,encoding='utf-8').read():
            raise RuntimeError('executor not in type template role table')
    m=next((m for m in list_messages(chat,start=now()-datetime.timedelta(hours=2)) if m.get('message_id')==mid),None)
    if not m or m.get('chat_id')!=chat: raise RuntimeError('message not found on exact target')
    mentions=m.get('mentions') or []
    if len(mentions)!=1 or mentions[0].get('id') not in {executor,executor_app(cs)}:
        raise RuntimeError('mention is not exactly the registered executor')
def spawn(parent,root,task,version):
    st=read_state(parent) or {}; d=st.get('delegation') or {}
    if not d.get('root_request_id'): return
    if not root and not task: return   # 未声明任务链的普通组织建群不受委派试运行链守卫约束
    bind=task_binding(st,task) or {}
    chain={'root_request_id':root,'task_id':task,'task_version':int(version),'parent_delivery_id':bind.get('delivery_message_id')}
    why=task_chain_guard(parent,None,task,chain)
    if why: raise RuntimeError(why)
def ancestors(parent):
    found=[]; cursor=parent
    while cursor:
        if cursor in found: raise RuntimeError('cycle in registered ancestor chain')
        st=read_state(cursor)
        if not st or st.get('chat_id')!=cursor: raise RuntimeError('missing exact ancestor state')
        found.append(cursor); up=st.get('parent')
        if up and cursor not in ((read_state(up) or {}).get('children') or []): raise RuntimeError('unregistered ancestor edge')
        cursor=up
    return found
def spawn_create(parent,root,task,version,*command):
    if len(command)<4 or command[0]!='lark-cli' or list(command[1:4])!=['im','chats','create']:
        raise RuntimeError('internal spawn-create accepts only the standard creation boundary')
    path=ancestors(parent)
    with AuthLocks(*path):
        if ancestors(parent)!=path: raise RuntimeError('ancestor topology drift before create')
        spawn(parent,root,task,version)
        # A pause committed before this lock is rejected; a concurrent pause
        # cannot commit until this already-authorized create attempt returns.
        return subprocess.run(command).returncode
if __name__=='__main__':
    try:
        if sys.argv[1]=='spawn-create': raise SystemExit(spawn_create(*sys.argv[2:]))
        {'legacy':legacy,'target':target,'spawn':spawn}[sys.argv[1]](*sys.argv[2:])
        print(json.dumps({'ok':True,'check':sys.argv[1]}))
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False)); raise SystemExit(9)
