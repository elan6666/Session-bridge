import type { Envelope } from '../protocol/types.js';
import type { BridgeStore } from '../core/database.js';
import { readTask } from '../core/tasks.js';
import { digest } from '../protocol/canonical.js';

// A durable notice about an already-authorized action, never a new task or owner.
export function verificationReadyEnvelope(store:BridgeStore,taskId:string):Envelope|null {
 const row=store.db.prepare('SELECT r.*,p.plan_json FROM task_returns r JOIN continuation_plans p USING(task_id) WHERE r.task_id=?').get(taskId);
 if(!row?.verified_at || !row.verification_json || !row.authority_json || row.state==='main_continued' || store.db.prepare('SELECT task_id FROM task_cancellations WHERE task_id=?').get(taskId))return null;
 const task=readTask(store,taskId);if(task.state!=='verified')return null;
 const saved=JSON.parse(String(row.verification_json)),plan=JSON.parse(String(row.plan_json)),authority=JSON.parse(String(row.authority_json));
 const cause=digest({task_id:taskId,result_sha256:row.result_sha256,verification:saved.evidence,next_action:plan});
 const body={text:'原主会话的核验已由原生执行历史确认。这是已授权任务的状态通知，不是新的人工权限。先查看当前 task；若已 main_continued，结束本轮；否则仅执行你之前固定的 next_action，使用原生 action 留证。不重新派发任务、不重复已完成的步骤。\n'+JSON.stringify({task_id:taskId,result_sha256:row.result_sha256,verification_action_id:saved.evidence.native_receipt.action_id,next_action:plan}),artifacts:[]};
 return {protocol_version:1,message_id:'verification-ready-'+cause,task_id:taskId,handoff_id:authority.handoff_id,authority_epoch:authority.epoch,sender:task.input.return_to,target:task.input.return_to,kind:'verification_ready',body,body_sha256:digest(body),created_at:String(row.verified_at),expires_at:new Date(Date.parse(String(row.verified_at))+86400000).toISOString(),causation_id:cause,correlation_id:taskId};
}
