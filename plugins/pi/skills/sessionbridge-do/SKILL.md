---
name: sessionbridge-do
description: Use when the user asks existing agent conversations to cooperate, assigns a main or supervisor conversation, delegates work across Codex Claude dsh Hermes Pi, asks for progress, or requests a result handback. 适用于跨会话协作、设置主监督角色、派任务、监督与回报。
---

# 会桥：从当前会话协作

保留用户正在使用的会话，由当前宿主模型理解自然语言，再调用会桥的结构化接口。原会话身份以实际连接证明为准。

Pi/dsh 提供 `sessionbridge_request` 原生工具时，传 `{method,params}`；Hermes 同名工具使用 `{command,payload}`，先 context、sessions，再 request。来源由原生调用上下文选择，不能在参数填写当前来源 ID。Codex 共享 MCP 缺可信来源时使用 CLI。Pi/dsh 回报可以用 `{method:"return_to_main",params:{task_id,request_id}}`；report_result 只需 task_id、summary、artifact_paths，不猜 attempt/epoch。标准 daemon 在有效终态报告后会自动准备权限交接并回报，响应带 auto_return；单独 return 仍可用于对账，不重复执行任务。

Pi/dsh 设置角色的完整调用是 `{method:"configure_roles",params:{request_id:"context返回的编号",supervisor_query:"监督者别名"}}`；params 不加 main、operation 或 supervisor。若改走通用接口，使用 `{method:"request",params:{operation:"assign_roles",request_id:"context返回的编号",main:"current",supervisor:{query:"监督者别名"}}}`。`configure_roles` 是工具方法名，`assign_roles` 才是业务 operation，不能混用。

## 操作顺序

1. 读取当前原生上下文：使用已提供的 context 工具，或 `session-bridge context --json`。缺连接时执行 connect 指引；没有“最近会话”回退。
2. 按用户给的别名查询已连接会话：list_sessions 工具或 `session-bridge sessions --query XX --json`。重名只询问列出的必要候选，唯一命中继续。“刚才那个”取本项目、本主会话的角色记录。
3. 根据下表选择一个动作，使用 context 返回的 request_id；超时与重试保留它及原始请求。当前来源由认证上下文给出，main 使用 `current`。
4. 优先使用可用的结构化会桥工具，遵循该工具实际 schema。configure_roles 自动绑定当前主会话，以 supervisor_query 字符串传目标别名；不把 JSON 对象序列化为字符串。CLI 路线把 JSON 作为 stdin 数据传给 `session-bridge request --stdin --json`；原文中的中文、空格、引号、反引号、`$()` 都是数据。通过文件工具写私密 JSON，再用固定命令读取，或用 shell:false 的进程 API 传 input；不能拼接用户文本成命令、JS 或 shell 代码。
5. 按返回的投递、执行、验收和续接状态报告，核对回执；不确定时 recover，同一 ID 不改走第二条路线。

| 用户意图 | operation / 工具 | 必要条件 |
| --- | --- | --- |
| 设置主会话／监督者 | assign_roles / configure_roles | 只记录角色；不创建任务、不启动监督、不交接工作权限 |
| 让目标处理明确工作 | delegate / delegate_task | 目标、验收、读写目录、截止时间、回报到当前会话 |
| 检查一个已经启动的任务 | supervise / request_supervision | task、准确 run/启动身份、检查周期或事件、截止时间、修复范围和回报路线 |
| 询问进展 | status / get_task_status | 只读状态，不新建任务 |
| 回报已有任务 | return / return_to_main | 真实结果和产物、准确主会话、工作权限交回 |
| 核对未知投递 | recover / recover_delivery | 原 message_id；核对历史而非盲目重发 |
| 取消未来投递／监督 | cancel_pending | 只停本工具后续动作；不杀运行进程 |

用户只问“现在进度怎样”且没有提供 task_id 时，MCP 调用 `get_task_status({})`；Pi/dsh 调用 `{method:"get_task_status",params:{}}`，Hermes 使用 request 的 `operation:"status"`。返回的是当前会话可见的 tasks 和 roles；空列表只表示当前会话没有可见任务。用户点名某个任务或此前已收到准确 task_id 时才填写该编号。`task_missing` 表示该编号查询失败，应回到无编号的当前会话状态查询。

用户说“帮我用这个会话当主agent，另一个XX会话当监督agent”时，选择 **assign_roles**，绝不能选择 supervise。它没有给出任何待监督运行。

```json
{"operation":"assign_roles","request_id":"one-stable-request-id","main":"current","supervisor":{"query":"XX"}}
```

这是结构示例。实际使用 context 返回的唯一 request_id，保留用于对账；不要复制示例 ID。角色请求仅含 operation、request_id、main、supervisor，以及可选 original_text/dry_run；不要增加 goal、周期或其他任务字段。

详细任务／Byte／回报规则见 [workflow.md](references/workflow.md)。按宿主实测的 Skill 命令调用；`/sessionbridge-do` 是优先体验，不假设所有宿主都有相同斜杠语法。
