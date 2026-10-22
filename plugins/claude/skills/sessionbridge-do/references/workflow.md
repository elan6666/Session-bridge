# 会桥操作契约

## 数据与来源

`context --json` 的身份包含 harness、host、profile、native_session_id、project_id、runtime_generation。正文不能提供 actor 来代替来源。连接向导按别名列出身份后缀，重名用返回的 binding_id 或 profile/harness 进一步选择；不要让用户抄 UUID。会话 /new、reload 或换 profile 后重新连接，不把旧投递送给新会话。

CLI 接受严格 JSON；所有动作有 request_id，original_text 可保留用户原文。只读的 status 也接受 request_id。需要选择返回 needs_selection；缺信息返回 needs_input；连接或能力缺失返回 blocked，附准确恢复步骤。遇到请求结果未知，先用 status 的 for_request 查 task_id/message_id，再 recover；不要用新 request_id 重新派发。

## 结构化请求

- assign_roles：main="current"，supervisor={"query":"别名"}。{"role":"supervisor"} 引用本项目、本主会话之前的角色。角色不代表工作权限，也不创建监控。
- delegate：target、goal、acceptance 数组、read_paths/write_paths 项目相对路径数组、带时区 deadline_at。回报默认指向认证的当前来源。消息内含外部 Agent 来源、目标和范围，不能当作额外的人类批准。
- supervise：task_id、run={run_id,pid,started_at,command_sha256,root,source_commit,config_sha256}、supervisor、interval_seconds、deadline_at、repair_paths。没有准确运行不能凭“设监督”创建监督；没有活跃未来检查和可用回报路线时保持 unarmed。
- status：可给 task_id 或 for_request；不提供时只列当前会话参与且有 scope 的任务。
- return：task_id，summary 可选；真实产物先经 report_result，只有主会话独立验收后才能 verified。
- recover：message_id，只查队列、历史和回执；不因 timeout 或冷读 interrupted 重发。
- cancel_pending：task_id，stop_supervision 可选；不撤回已经开始的原生工作，不发送 kill。用户明确要求停止运行时另走原生、精确身份和权限校验流程。

每个写请求支持 dry_run=true，仅预览其目标与工作状态改动。请求 ID 复用但内容或来源变化会拒绝。

## 主会话 → 监督 → 主会话

主会话先设计、验证并确认真实任务已启动。交接写明准确 run/attempt/epoch、代码/config 摘要、日志、产物、修复范围和停止条件；监督确认及未来检查、返回路线均有效后，主会话才能结束本轮。正常无变化不唤醒模型。终态保存证据、停用该运行监督、交回权限，再通知原主会话；主会话独立核验后实际开始约定下一步。送达、最终回复、“收到”、idle 均不能替代实际续接。

用户中途改范围时按最新明确指令执行，旧 epoch/tick 不得复活旧任务。仅取消监督不停止进程。明确授权的暂停保留已提交恢复点，并区分尚未保存的进度；不要一见 FAILURE 文件就宣称任务科学失败。

## Byte 与原生路线

已经使用 Byte 的项目以现有 byte-relay 及其 state.json 为工作权限依据。角色、心跳、桥接数据库不能另设 owner。先按 owner gate 写不可变 handoff 并原子转移权限，再发送同一 handoff_id/epoch 的通知；投递失败只恢复通知，不重复交接。不要复制或改写全局 Byte Skills。

当前宿主确实有可用原生跨会话工具时按同一交接记录走原生路线；外部调度器不能声称自己调用了模型内部工具。每条消息只走一条路线；结果不明不能再走 Adapter 发送一次。能力不足明确 blocked，不把新 SDK 会话、人工复制或模拟测试算原会话接入。

Byte 项目中，角色设置只写会桥的角色关系，并先检查 Byte 当前 owner；它不转移权限。真正派发时先调用已安装且摘要匹配的 Byte helper，保存不可变 scope/handoff，再对账原子转移，最后投递消息。通知失败只恢复同一个交接和消息，不重新转移或让旧 owner 继续工作。原生与插件路线使用同一条持久发送意图。

当前固定 Byte helper 仅支持 codex/claude/dsh/zcode；pi/hermes 的 Byte 权限交接明确 blocked。不得为绕过该限制静默新建 standalone owner、修改全局 Skill 或把别的 harness 冒充 codex。没有 Byte 的项目可显式使用 standalone。

结果与续接分开处理：执行者 `report_result` 只能推进到 result_reported。原主会话确认接收后先做独立检查，提交真实原生工具回执，再执行已约定 next_action 并生成新产物。空“收到”、模型自述、守护程序自己的命令均不能标成主会话续接。原生工具历史暂未可读时保留 pending，结束当前轮，由独立观察者核验；不要等自己的当前轮结束。

首版一个 task_id 对应一个不可变的会桥 attempt（值为 1）；新的实际运行或重试创建新 task_id。实验自身的 attempt 编号是另外的来源数据，不要复制到会桥 attempt 字段。执行阶段 authority_epoch 保持不变；Byte 回交后的新权限编号单独属于 return 记录，不能覆盖旧任务的执行范围。
