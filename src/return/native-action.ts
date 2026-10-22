import { randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Actor } from '../protocol/types.js';
import type { BridgeStore } from '../core/database.js';
import type { ActionEvidence } from './service.js';
import { digest,sessionKey } from '../protocol/canonical.js';
import { privateDirectory } from '../core/private-paths.js';
import { readTask,requireActor } from '../core/tasks.js';
import { runtimeWorkflow } from '../core/runtime.js';
import { originalCodexOwner,codexConfigSchema } from '../adapters/codex/connect.js';
import { CodexStdio } from '../adapters/codex/stdio.js';
import { validateCodexBinary } from '../adapters/codex/version.js';
import { runWithReceipt } from '../cli/run-with-receipt.js';
import { withinPaths } from './continuation.js';
import { BridgeError } from '../protocol/errors.js';
import { prepareActionAttempt } from './attempt.js';
export const actionInputSchema=z.strictObject({task_id:z.string().min(1),purpose:z.enum(['verification','continuation']),argv:z.array(z.string()).min(1),artifact_paths:z.array(z.string()).min(1),next_action_id:z.string().optional()});
export async function executeNativeAction(store:BridgeStore,actor:Actor,raw:unknown,actionId:string){
 const input=actionInputSchema.parse(raw),row=store.db.prepare('SELECT input_json FROM tasks WHERE task_id=?').get(input.task_id);
 if(!row)throw new Error('Task not found');const task=readTask(store,input.task_id);
 if(actor.session.harness!=='codex' || process.env.CODEX_THREAD_ID!==actor.session.native_session_id || sessionKey(actor.session)!==sessionKey(task.input.return_to))throw new BridgeError('native_action_unavailable','本版本尚不能证明当前宿主执行了主会话动作','请在原 Codex 主会话中执行 action；其他宿主的实际动作验收仍待接入',3);
 const guard=()=>{
  requireActor(store,actor,'acknowledge_task',input.task_id);
  if(store.db.prepare('SELECT task_id FROM task_cancellations WHERE task_id=?').get(input.task_id) || readTask(store,input.task_id).state==='cancelled')throw new BridgeError('continuation_cancelled','Task actions were cancelled','Create an explicitly authorized new task before running more work',3);
  if(input.purpose==='continuation'){
   if(store.db.prepare('SELECT state FROM task_returns WHERE task_id=?').get(input.task_id)?.state==='main_continued')throw new BridgeError('continuation_already_completed','The original main already completed this next action','Inspect the saved receipt; do not execute the step again',3);
   const planRow=store.db.prepare('SELECT plan_json FROM continuation_plans WHERE task_id=?').get(input.task_id),verification=store.db.prepare('SELECT verified_at FROM task_returns WHERE task_id=?').get(input.task_id);
   if(!planRow || !verification?.verified_at || readTask(store,input.task_id).state!=='verified')throw new BridgeError('verification_missing','Verified result and fixed next action are required before execution','Complete original-main verification first',6);
   const plan=JSON.parse(String(planRow.plan_json));if(plan.next_action_id!==input.next_action_id || plan.argv_sha256!==digest(input.argv) || digest([...plan.artifact_paths].sort())!==digest([...input.artifact_paths].sort()))throw new BridgeError('next_action_mismatch','Command or outputs differ from the fixed next action','Run the exact authorized next step',6);
  }
 };
 guard();await runtimeWorkflow(store).roleGate?.(actor);
 const result=store.db.prepare('SELECT sha256 FROM task_results WHERE task_id=?').get(input.task_id);if(!result)throw new Error('Result not reported');
 if(input.artifact_paths.some(path=>!withinPaths(path,[...task.input.read_paths,...task.input.write_paths])))throw new Error('Action artifact outside task scope');
 const config=codexConfigSchema.parse(JSON.parse(readFileSync(join(store.root,'.session-bridge','connectors','codex',digest(actor.binding_id)+'.json'),'utf8')));
 const owner=await originalCodexOwner(config.desktopBinary);if(digest(owner)!==digest(config.owner))throw new Error('Original source owner changed');
 const id=actionId;if(!/^[A-Za-z0-9_-]{8,100}$/.test(id))throw new Error('Action ID must be a stable 8-100 character token');
 guard();const dir=privateDirectory(store.root,['.session-bridge','actions',digest(id)]);
 prepareActionAttempt(store.root,input.task_id,id,input.purpose,{actor,input,action_id:id,owner,created_at:new Date().toISOString()});
 const handle=await runWithReceipt({root:store.root,argv:input.argv,source_commit:'task:'+input.task_id,config_sha256:digest(input),artifacts:input.artifact_paths,run_id:'action-'+id}),run=await handle.completion;
 if(run.exit_code!==0)throw new BridgeError('action_failed','主会话实际命令失败，未提交成功证明','检查本次运行私有日志；修复后使用新的动作编号',6);
 if(run.artifacts.length!==input.artifact_paths.length)throw new Error('Action expected outputs are missing');
 const evidence:ActionEvidence&{next_action_id?:string}={attempt:1,authority_epoch:task.input.authority.epoch,result_sha256:String(result.sha256),command:{argv:input.argv,exit_code:0},native_receipt:{session:actor.session,native_call_id:'action:'+id,action_id:id,occurred_at:new Date().toISOString()},artifacts:run.artifacts,...(input.purpose==='continuation'?{next_action_id:input.next_action_id}: {})};
 const file=join(dir,'evidence.json');writeFileSync(file,JSON.stringify(evidence),{flag:'wx',mode:0o600});
 const marker='SESSIONBRIDGE_ACTION:'+id+':'+digest(evidence);writeFileSync(join(dir,'record.json'),JSON.stringify({binding_id:actor.binding_id,purpose:input.purpose,evidence_sha256:digest(evidence),marker,run_id:handle.identity.run_id}),{flag:'wx',mode:0o600});
 return {evidence,file,marker};
}
interface CommandItem {type:string;id:string;command?:string;status?:string;exitCode?:number;aggregatedOutput?:string}
export function matchesNativeAction(items:CommandItem[],evidence:ActionEvidence,marker:string):CommandItem|undefined{return items.find(i=>i.type==='commandExecution' && i.status==='completed' && i.exitCode===0 && Boolean(i.command?.includes('--action-id '+evidence.native_receipt.action_id)) && /\baction\b/.test(i.command!) && Boolean(i.aggregatedOutput?.includes(marker)));}
export async function verifyRecordedAction(store:BridgeStore,actor:Actor,evidence:ActionEvidence,purpose:'verification'|'continuation'):Promise<boolean>{
 try{
  if(actor.session.harness!=='codex' || sessionKey(evidence.native_receipt.session)!==sessionKey(actor.session))return false;
  const dir=join(store.root,'.session-bridge','actions',digest(evidence.native_receipt.action_id)),record=JSON.parse(readFileSync(join(dir,'record.json'),'utf8')) as {binding_id:string;purpose:string;evidence_sha256:string;marker:string};
  if(record.binding_id!==actor.binding_id || record.purpose!==purpose || record.evidence_sha256!==digest(evidence))return false;
  const proofPath=join(dir,'native-proof.json');try{const proof=JSON.parse(readFileSync(proofPath,'utf8'));if(proof.evidence_sha256===digest(evidence) && sessionKey(proof.session)===sessionKey(actor.session))return true;}catch{/* No earlier native observation. */}
  const config=codexConfigSchema.parse(JSON.parse(readFileSync(join(store.root,'.session-bridge','connectors','codex',digest(actor.binding_id)+'.json'),'utf8')));await validateCodexBinary(config.desktopBinary,config.expectedVersion);
  const c=new CodexStdio({binary:config.desktopBinary,codexHome:config.codexHome,cwd:store.root});try{
   let cursor:string|null=null;
   for(let n=0;n<20;n++){
    const page=await c.request('thread/turns/list',{threadId:actor.session.native_session_id,itemsView:'full',limit:100,cursor}) as {data:{id:string;items:CommandItem[]}[];nextCursor?:string|null};
    for(const turn of page.data){const match=matchesNativeAction(turn.items,evidence,record.marker);if(match){writeFileSync(join(dir,'native-proof.json'),JSON.stringify({session:actor.session,turn_id:turn.id,native_call_id:match.id,evidence_sha256:digest(evidence)}),{mode:0o600});return true;}}
    cursor=page.nextCursor??null;if(!cursor)break;
   }
   return false;
  }finally{await c.close();}
 }catch{return false;}
}
export function newActionId():string{return randomUUID();}
