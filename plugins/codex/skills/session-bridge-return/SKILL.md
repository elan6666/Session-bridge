---
name: session-bridge-return
description: Use when a delegated or supervised task has evidence to report, needs handback to its exact main conversation, or requires verification of main continuation.
---

# 向原主会话回报

使用 sessionbridge-do 及其 references/workflow.md 的 return 契约。核对 task/attempt/epoch 与准确原主会话，保存真实产物和回执；按项目工作流交回权限后发送结果。停止本次运行监督。主会话独立核对摘要和实际结果，并开始指定下一步；送达、idle、最终文本或“收到”均不算 main_continued。未知就报告未知，不伪造验收。

与主入口一同安装，按宿主实测语法调用。原生接入、自然语言调用和完整闭环的支持状态以 doctor／验收报告为准；不能用本文件存在代替验证。
