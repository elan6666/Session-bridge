---
name: session-bridge-supervise
description: Use when the user explicitly requests checks for an already started run, specifies supervision timing, or changes the scope of an existing supervised task.
---

# 监督已启动的运行

使用 sessionbridge-do 及其 references/workflow.md 的 supervise 契约。只有确切 task/run/启动身份、周期或事件、截止时间、修复范围、监督者与原主会话齐全才请求监督；缺项只问必要信息。角色设置不启动检查。核对接收、活跃未来检查与回报路线，缺任何项显示 unarmed。正常无变化保持安静。用户改范围后旧 epoch/tick 无效；交回时停止旧监督。取消监督不停止进程。

与主入口一同安装，按宿主实测语法调用。原生接入、自然语言调用和完整闭环的支持状态以 doctor／验收报告为准；不能用本文件存在代替验证。
