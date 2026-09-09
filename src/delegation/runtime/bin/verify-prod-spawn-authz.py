#!/usr/bin/env python3
"""Registry-bound message reader used by the delegation runtime."""
import json,sys,subprocess,datetime,glob,os,stat,hashlib

RECORDS_DIR = os.path.expanduser(os.environ.get('P5_HOME', '~/.botmux/delegation'))

def configured_owners():
    path = os.environ.get('P5_CONFIG') or os.path.join(RECORDS_DIR, 'cost-opt/p5/p5-config.json')
    with open(path, encoding='utf-8') as f: conf = json.load(f)
    return {o['lark_app_id']: o['owner_open_id'] for o in conf.get('owners', []) if o.get('verified_at')}

OWNER_BY_APP = configured_owners()
def out(s): print(s); sys.exit(0)

def option(name):
    if name not in sys.argv: return None
    i=sys.argv.index(name)
    if i+1>=len(sys.argv): out("BAD %s 缺参数"%name)
    return sys.argv[i+1]

def data_dir():
    """Same precedence as the installed botmux core/data-dir.js.

    BOTMUX_HOME is not a quoted session selector. Never infer the reader from
    it: quoted uses SESSION_DATA_DIR, then the daemon breadcrumb, then default.
    """
    explicit=os.environ.get('SESSION_DATA_DIR','').strip()
    if explicit: return os.path.abspath(explicit)
    home=os.path.expanduser('~/.botmux')
    breadcrumb=os.path.join(home,'.data-dir')
    try:
        s=os.lstat(breadcrumb)
        if stat.S_ISREG(s.st_mode) and s.st_size<=4096:
            with open(breadcrumb,encoding='utf-8') as f: candidate=f.read().strip()
            if os.path.isabs(candidate) and os.path.isdir(candidate): return os.path.abspath(candidate)
    except OSError: pass
    return os.path.join(home,'data')

def resolve_reader(session_id, directory):
    """从 botmux 权威 session registry 解析实际 reader app；必须唯一命中。"""
    hits=[]
    paths=glob.glob(os.path.join(directory,"sessions-*.json"))
    legacy=os.path.join(directory,'sessions.json')
    if os.path.exists(legacy): paths.append(legacy)
    for path in paths:
        try: data=json.load(open(path))
        except Exception: continue
        # Actual botmux enumerates Object.values(), including legacy arrays.
        # Checking just data[session_id] misses a shadow row under another key.
        rows=list(data.items()) if isinstance(data,dict) else list(enumerate(data)) if isinstance(data,list) else []
        for key,entry in rows:
            if not isinstance(entry,dict): continue
            if key!=session_id and entry.get('sessionId')!=session_id: continue
            if key!=session_id or entry.get('sessionId')!=session_id:
                out('BAD reader session key 与 sessionId 不一致（含 array/shadow row）')
            file_app=os.path.basename(path)[len("sessions-"):-len(".json")] if path!=legacy else None
            actual=entry.get("larkAppId")
            if file_app is not None and actual!=file_app:
                out("BAD reader session registry 内外 app 不一致(session=%s, entry=%s, file=%s)"%(session_id,actual,file_app))
            hits.append((actual,entry,path))
    if not hits: out("BAD reader session 未在 botmux registry 登记: %s"%session_id)
    if len(hits)!=1: out("BAD reader session 在多个 app registry 命中，身份不唯一: %s"%session_id)
    return hits[0]

def main():
    if len(sys.argv)<3: out("BAD 用法: <authz.json> <parent_chat_id> --reader-session <uuid> --declared-app <cli_xxx>")
    authz,parent = sys.argv[1], sys.argv[2]
    # 兼容旧形状 <authz> <owner_hint> <parent>，但不信任/使用 owner_hint。
    if parent.startswith("ou_") and len(sys.argv)>3: parent=sys.argv[3]
    session_id=option("--reader-session")
    declared=option("--declared-app") or option("--app")
    if not session_id: out("BAD 缺实际 reader session 身份（--reader-session）")
    if not declared: out("BAD 缺调用方声明 app（--declared-app）；无法校验声明与实际 reader 一致")
    # quoted's env-only/Riff branch would bypass the registry. This local-only
    # task gate rejects it rather than trusting a supplied app/secret pair.
    if os.environ.get('BOTMUX_LARK_APP_SECRET'): out('BAD 不支持 env-only/Riff reader；无法用本地 registry 证明身份')
    directory=data_dir()
    app,session,path=resolve_reader(session_id,directory)
    if not app: out("BAD reader session 缺 larkAppId")
    if app not in OWNER_BY_APP: out("BAD 实际 reader app 未知/不在可信表: %s"%app)
    if declared!=app: out("BAD 宣称 app(%s) 与实际 reader app(%s) 不符"%(declared,app))
    if session.get("status")!="active": out("BAD reader session 非 active(status=%s)"%session.get("status"))
    if session.get("chatId")!=parent: out("BAD reader session 所属群(%s) 与 parent(%s) 不符"%(session.get("chatId"),parent))

    try: a=json.load(open(authz))
    except Exception as e: out("BAD 授权文件解析失败: %s"%e)

    mid=a.get("message_id")
    if not mid: out("BAD 授权文件缺 message_id")

    # 有效期
    exp=a.get("expires_at")
    if not exp: out("BAD 授权文件缺 expires_at（不接受无期限授权）")
    try:
        if datetime.datetime.now(datetime.timezone.utc) > datetime.datetime.fromisoformat(exp).astimezone(datetime.timezone.utc):
            out("BAD 授权已于 %s 过期，请让 owner 重新授权"%exp)
    except Exception as e:
        out("BAD expires_at 解析失败(%s): %s"%(exp,e))

    # 范围：parent 必须落在某个授权子树内（含自身），沿 state 的 parent 链向上走。
    allowed=a.get("allowed_subtree_roots") or a.get("allowed_parents")
    if not isinstance(allowed,list) or not allowed:
        out("BAD 授权文件缺 allowed_subtree_roots（不接受无范围授权）")
    pmap={}
    for f in glob.glob(os.path.join(RECORDS_DIR,"webroot","state-*.json")):
        try: st=json.load(open(f))
        except Exception: continue
        cid=st.get("chat_id")
        if cid: pmap[cid]=st.get("parent")
    cur=parent; chain=[]; seen=set(); hit=None
    while cur and cur not in seen:
        seen.add(cur); chain.append(cur)
        if cur in allowed: hit=cur; break
        cur=pmap.get(cur)
    if not hit:
        out("BAD 父群 %s 不在任何授权子树内（向上走了 %d 层：%s）"%(parent,len(chain)," → ".join(chain[:5])))

    # 回读消息，核 sender 是否匹配安装时配置的 app 视角 owner。
    try:
        botmux=os.environ.get("BOTMUX_BIN","botmux")
        reader_env=dict(os.environ,SESSION_DATA_DIR=directory,BOTMUX_LARK_APP_ID=app)
        pr=subprocess.run([botmux,"quoted",mid,"--session-id",session_id],capture_output=True,text=True,timeout=90,env=reader_env)
        # 退出码必须检查：读取失败但 stdout 里恰好留有可解析正文时，旧版会当成读取成功继续放行
        # 读取失败不能使用失败进程遗留的可解析输出。
        if pr.returncode!=0:
            out("BAD 回读授权消息失败：botmux quoted 退出码=%d，stderr=%s"%(pr.returncode,(pr.stderr or "").strip()[:120]))
        r=pr.stdout
        i=r.find("{")
        if i<0: out("BAD 回读授权消息无返回")
        m=json.loads(r[i:])
    except Exception as e:
        out("BAD 回读授权消息失败(%s)"%e)
    app_after,after,path_after=resolve_reader(session_id,directory)
    if (app_after,path_after,after.get('sessionId'),after.get('chatId'),after.get('status')) != (app,path,session_id,parent,'active'):
        out('BAD reader 身份在回读期间变化，拒绝接受结果')
    if m.get('messageId')!=mid: out('BAD 回读 messageId 与授权消息不符')
    if not isinstance(m.get('content'),str) or not m['content'].strip(): out('BAD 授权消息正文为空')
    sid=m.get("senderId")
    if m.get("senderType")!="user": out("BAD 该消息不是真人发的(senderType=%s)"%m.get("senderType"))
    expect = OWNER_BY_APP[app]
    if sid!=expect: out("BAD 该消息 sender(%s) 不是实际 reader app %s 视角下的 owner(%s)"%(sid,app,expect))
    out("OK reader_app=%s reader_session=%s reader_data_dir=%s owner=%s message_id=%s content_sha256=%s content=%s"%(app,session_id,directory,sid,mid,hashlib.sha256(m['content'].encode()).hexdigest(),m['content'].strip()[:40]))

if __name__=='__main__': main()
