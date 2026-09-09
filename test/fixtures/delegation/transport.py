#!/usr/bin/env python3
"""Test-only transport. Never calls a network endpoint; every ID is simulated."""
import datetime, json, os, re, sys
from pathlib import Path
path=Path(os.environ['DELEGATION_FIXTURE_MESSAGES'])
messages=json.loads(path.read_text()) if path.exists() else []
args=sys.argv[1:]
def option(name,default=None): return args[args.index(name)+1] if name in args else default
def post(chat,body,kind='app',sender=None):
    mid='om_fixture'+str(len(messages)+1)
    at=datetime.datetime(2026,1,1,10,1)+datetime.timedelta(seconds=len(messages))
    mentions=[{'id':m,'key':'@_user_1','name':'Executor'} for m in re.findall(r'<at user_id="([^"]+)">',body)]
    messages.append({'message_id':mid,'chat_id':chat,'msg_type':'text','content':body,'create_time':at.strftime('%Y-%m-%d %H:%M:%S'),
                     'sender':{'id':sender or ('ou_owner' if kind=='user' else 'cli_executor'),'sender_type':kind,'id_type':'open_id' if kind=='user' else 'app_id'},'mentions':mentions})
    path.write_text(json.dumps(messages)); return mid
if args[:2]==['fixture','post']:
    print(post(args[2],args[3],args[4] if len(args)>4 else 'app'))
elif args[:2]==['im','+chat-members-list']:
    print(json.dumps({'ok':True,'data':{'chat_id':option('--chat-id'),'users':[{'member_id':'ou_owner'}],
                                     'bots':[{'app_id':'cli_executor','member_id':'ou_executor'},{'app_id':'cli_observer','member_id':'ou_observer'}]}}))
elif args[:2]==['im','+chat-messages-list']:
    print(json.dumps({'data':{'messages':[m for m in reversed(messages) if m['chat_id']==option('--chat-id')],'has_more':False}}))
elif args[:2]==['im','+messages-send']:
    print(json.dumps({'data':{'message_id':post(option('--chat-id'),option('--text'), 'user' if option('--as')=='user' else 'app')}}))
elif args[:2]==['bots','list']:
    print(json.dumps({'bots':[{'larkAppId':'cli_executor','openId':'ou_executor','isSelf':True,'mentionable':True},
                              {'larkAppId':'cli_observer','openId':'ou_observer','isSelf':False,'mentionable':True}]}))
elif args[:1]==['quoted']:
    m=next(m for m in messages if m['message_id']==args[1])
    at=datetime.datetime.strptime(m['create_time'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
    print(json.dumps({'messageId':m['message_id'],'rootId':messages[0]['message_id'],'senderId':m['sender']['id'],'senderType':m['sender']['sender_type'],
                      'msgType':'text','content':m['content'],'rawContent':{'text':m['content']},'createTime':str(int(at.timestamp()*1000))}))
elif args[:1]==['send']:
    body=sys.stdin.read(); mid=post(option('--chat-id'),body)
    messages[-1]['mentions']=[{'id':option('--mention'),'key':'@_user_1'}]
    path.write_text(json.dumps(messages)); print(json.dumps({'success':True,'messageId':mid}))
else:
    print('fixture refuses unsupported operation: '+repr(args),file=sys.stderr); sys.exit(2)
