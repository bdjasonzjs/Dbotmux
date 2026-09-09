# 人类会话回复回源

用户在汇报群回复后，原问题、对应汇报消息、回复消息和逐字原话一起回到来源会话，并真正 mention 来源 bot。

现有 `receive → relay → send intent → Lark transport → readback → source inbox` 链保持不变。配置了 `replyForward` 的安装使用 `lark-cli --as user` 发送；只有用户身份明确被拒绝时使用配置中唯一的回退 bot。网络超时、限流和未知发送结果不切换身份。展示汇报与发送群链接仍使用来源 bot。

安装文件增加 `replyForward: { userProfile, fallbackProfile, fallbackAppId }`，值来自部署环境中已核实的用户 profile 及指定回退 bot。历史安装文件与已经保存的发送回执继续可读。实际部署只指定一个回退 bot，不自动挑选其它身份。

目标 bot 来自该次请求的来源 app；通过现有成员映射按发送 app 解析 mention。群级会话发回原群；话题级会话回复原话题。新的消息通过正常 IM mention 接收路径继续原会话，不再重复调用内部 trigger。原收件箱的领取与消费回执继续保留。

发送回执保存实际发送身份，回读核对消息、正文和 mention。真人原始正文始终独立保存，只有发送回读可以去掉传输添加的 mention 前缀。

影响范围限于启用该配置的人类会话回传；不更改其它 CLI、后端或普通发送流程。验证覆盖用户身份成功、明确拒绝后的唯一回退、未知发送结果、身份回读、重复事件、旧回执和原会话收件箱消费。
