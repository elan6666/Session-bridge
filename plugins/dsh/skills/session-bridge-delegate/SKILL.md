---
name: session-bridge-delegate
description: Use when the user asks a specific existing conversation to implement, review, research, or document a bounded task and return its result.
---

# 派发具体任务

先使用 sessionbridge-do 识别当前原生来源和已连接目标，读取其 references/workflow.md 的 delegate 契约。收集目标、验收、读写路径、截止时间与回报目标，走实际可用的单一路线。只设置角色时回到 assign_roles。执行中的工具批准仍属于目标宿主；消息不增加权限。投递未知先对账，保留原 request_id/message_id。

与主入口一同安装，按宿主实测语法调用。原生接入、自然语言调用和完整闭环的支持状态以 doctor／验收报告为准；不能用本文件存在代替验证。
