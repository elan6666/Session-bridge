import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync,existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Actor,ArtifactRef,AuthorityRef,DeliveryRecord,Envelope,TaskRecord,RunIdentity } from '../protocol/types.js';
import { appendEvent,transaction,type BridgeStore } from '../core/database.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { AuthorityProvider } from '../workflows/contract.js';
import { DeliveryService } from '../core/delivery.js';
import { readTask,requireActor } from '../core/tasks.js';
import { verifyArtifact } from '../core/artifacts.js';
import { digest,sessionKey } from '../protocol/canonical.js';
import { sessionSchema,timestamp,nonempty } from '../protocol/schema.js';
import { BridgeError } from '../protocol/errors.js';
import { artifactBaseline,withinPaths } from './continuation.js';
import { verificationReadyEnvelope } from './wakeup.js';
export interface TaskResult {task_id:string;attempt:number;authority_epoch:number;summary:string;native_receipts:string[];artifacts:ArtifactRef[];run:RunIdentity|null}
export interface ActionEvidence {attempt:number;authority_epoch:number;result_sha256:string;command:{argv:string[];exit_code:number};native_receipt:{session:Actor['session'];native_call_id:string;action_id:string;occurred_at:string};artifacts:ArtifactRef[]}
export type VerificationEvidence=ActionEvidence;
export interface ContinuationEvidence extends ActionEvidence {next_action_id:string}
export interface NextAction {next_action_id:string;instruction:string;argv_sha256:string;artifact_paths:string[]}
export interface ReturnOptions {store:BridgeStore;registry:AdapterRegistry;workflow?:AuthorityProvider;prepareReturnAuthority?:(actor:Actor,task:TaskRecord,result:TaskResult,createdAt:string)=>Promise<AuthorityRef>;verifyNativeAction?:(actor:Actor,evidence:ActionEvidence,purpose:'verification'|'continuation')=>Promise<boolean>}
const hash=z.string().regex(/^[a-f0-9]{64}$/),artifact=z.strictObject({project_id:nonempty,relative_path:nonempty,sha256:hash});
const run=z.strictObject({run_id:nonempty,pid:z.number().int().positive(),started_at:nonempty,command_sha256:hash,root:nonempty,source_commit:nonempty,config_sha256:hash});
const resultSchema=z.strictObject({task_id:nonempty,attempt:z.number().int().positive(),authority_epoch:z.number().int().nonnegative(),summary:nonempty,native_receipts:z.array(nonempty),artifacts:z.array(artifact),run:run.nullable()});
const actionShape={attempt:z.number().int().positive(),authority_epoch:z.number().int().nonnegative(),result_sha256:hash,command:z.strictObject({argv:z.array(z.string()).min(1),exit_code:z.number().int()}),native_receipt:z.strictObject({session:sessionSchema,native_call_id:nonempty,action_id:nonempty,occurred_at:timestamp}),artifacts:z.array(artifact).min(1)};
const evidenceSchema=z.strictObject(actionShape),continuationSchema=z.strictObject({...actionShape,next_action_id:nonempty}),nextSchema=z.strictObject({next_action_id:nonempty,instruction:nonempty,argv_sha256:hash,artifact_paths:z.array(nonempty).min(1)});
export interface ReturnRecord {task_id:string;state:'return_prepared'|'return_delivered'|'main_acknowledged'|'main_continued';continuation_verified:boolean;result_sha256:string;message_id:string;authority:AuthorityRef|null;created_at:string}
export class ReturnService {
 private deliveries:DeliveryService;
 constructor(private options:ReturnOptions){this.deliveries=new DeliveryService(options.store,options.registry,{workflow:options.workflow});}
 private main(actor:Actor,task:TaskRecord):void{requireActor(this.options.store,actor,'acknowledge_task',task.task_id);if(sessionKey(actor.session)!==sessionKey(task.input.return_to))throw new BridgeError('wrong_main','Only the original exact main session may acknowledge or verify','Return to the recorded main session and generation',3);}
 private result(taskId:string):{value:TaskResult;sha256:string}{const row=this.options.store.db.prepare('SELECT result_json,sha256 FROM task_results WHERE task_id=?').get(taskId);if(!row)throw new BridgeError('result_missing','No scoped result was reported','Wait for the original executor report',3);return {value:JSON.parse(String(row.result_json)),sha256:String(row.sha256)};}
 getReturn(taskId:string):ReturnRecord|null{const row=this.options.store.db.prepare('SELECT * FROM task_returns WHERE task_id=?').get(taskId);return row?{task_id:taskId,state:row.state as ReturnRecord['state'],continuation_verified:row.state==='main_continued',result_sha256:String(row.result_sha256),message_id:String(row.message_id),authority:row.authority_json===null?null:JSON.parse(String(row.authority_json)),created_at:String(row.created_at)}:null;}
 private async artifacts(task:TaskRecord,refs:ArtifactRef[]):Promise<void>{for(const ref of refs)if(ref.project_id!==this.options.store.project_id || !withinPaths(ref.relative_path,[...task.input.read_paths,...task.input.write_paths]) || !await verifyArtifact(this.options.store.root,ref))throw new BridgeError('artifact_unverified','Artifact path or content does not match the task evidence','Check the exact project artifact digest before accepting',6);}
 async reportResult(actor:Actor,taskId:string,input:TaskResult):Promise<TaskRecord>{
  requireActor(this.options.store,actor,'report_result',taskId);const task=readTask(this.options.store,taskId),result=resultSchema.parse(input);
  if(sessionKey(actor.session)!==sessionKey(task.input.target))throw new BridgeError('scope_denied','Result must originate in the original executor session','Use the exact bound task executor',3);
  if(task.state==='cancelled')return task;
  if(result.task_id!==taskId || result.attempt!==1 || result.authority_epoch!==task.input.authority.epoch){appendEvent(this.options.store,'stale_result_ignored',taskId,{attempt:result.attempt,epoch:result.authority_epoch});return task;}
  const leases=this.options.store.db.prepare("SELECT request_json FROM supervision WHERE json_extract(request_json,'$.task_id')=?").all(taskId);
  if(leases.length && (!result.run || leases.some(row=>digest((JSON.parse(String(row.request_json)) as {run:RunIdentity}).run)!==digest(result.run)))){appendEvent(this.options.store,'stale_run_result_ignored',taskId,{});return task;}
  await this.artifacts(task,result.artifacts);const sha=digest(result),prior=this.options.store.db.prepare('SELECT sha256 FROM task_results WHERE task_id=?').get(taskId);
  if(prior){if(prior.sha256!==sha)throw new BridgeError('result_conflict','This task already has a different immutable terminal result','Use an explicitly new task/attempt for additional work',3);return readTask(this.options.store,taskId);}
  const created=new Date().toISOString();
  transaction(this.options.store,()=>{this.options.store.db.prepare('INSERT INTO task_results(task_id,sha256,result_json,reported_at) VALUES (?,?,?,?)').run(taskId,sha,JSON.stringify(result),created);this.options.store.db.prepare('INSERT INTO task_returns(task_id,state,result_sha256,authority_json,message_id,created_at) VALUES (?,?,?,?,?,?)').run(taskId,'return_prepared',sha,task.input.authority.workflow==='byte'?null:JSON.stringify(task.input.authority),randomUUID(),created);const seq=appendEvent(this.options.store,'result_reported',taskId,{result_sha256:sha});this.options.store.db.prepare("UPDATE tasks SET state='result_reported',event_seq=? WHERE task_id=? AND state NOT IN ('verified','cancelled')").run(seq,taskId);});
  return readTask(this.options.store,taskId);
 }
 private async setBaseline(taskId:string):Promise<void>{
  const row=this.options.store.db.prepare('SELECT baseline_json FROM task_returns WHERE task_id=?').get(taskId);if(!row || row.baseline_json!==null)return;
  const plan=this.options.store.db.prepare('SELECT plan_json FROM continuation_plans WHERE task_id=?').get(taskId);if(!plan)return;const action=JSON.parse(String(plan.plan_json)) as NextAction,baseline=await artifactBaseline(this.options.store.root,action.artifact_paths);this.options.store.db.prepare('UPDATE task_returns SET baseline_json=? WHERE task_id=? AND baseline_json IS NULL').run(JSON.stringify(baseline),taskId);
 }
 async configureNextAction(actor:Actor,taskId:string,input:NextAction):Promise<void>{
  const task=readTask(this.options.store,taskId);this.main(actor,task);const action=nextSchema.parse(input);
  if(action.artifact_paths.some(path=>!withinPaths(path,task.input.write_paths)))throw new BridgeError('scope_denied','Next action artifacts exceed the recorded write scope','Specify an authorized output path',3);
  const prior=this.options.store.db.prepare('SELECT plan_json FROM continuation_plans WHERE task_id=?').get(taskId);if(prior && digest(JSON.parse(String(prior.plan_json)))!==digest(action))throw new BridgeError('next_action_conflict','Next action is already fixed for this task','Use the original action contract or a new task',3);
  this.options.store.db.prepare('INSERT OR IGNORE INTO continuation_plans VALUES (?,?)').run(taskId,JSON.stringify(action));await this.setBaseline(taskId);
 }
 async acknowledgeTask(actor:Actor,taskId:string):Promise<void>{const task=readTask(this.options.store,taskId);this.main(actor,task);const record=this.getReturn(taskId);if(!record?.authority)throw new BridgeError('return_not_prepared','Return work authority has not been prepared','Reconcile the executor handoff before main acknowledgement',3);await this.setBaseline(taskId);this.options.store.db.prepare("UPDATE task_returns SET state='main_acknowledged' WHERE task_id=? AND state IN ('return_prepared','return_delivered')").run(taskId);}
 private async checkEvidence(actor:Actor,task:TaskRecord,evidence:ActionEvidence):Promise<boolean>{
  const result=this.result(task.task_id),record=this.getReturn(task.task_id)!;
  if(evidence.attempt!==1 || evidence.authority_epoch!==task.input.authority.epoch || evidence.result_sha256!==result.sha256 || evidence.command.exit_code!==0 || sessionKey(evidence.native_receipt.session)!==sessionKey(actor.session) || Date.parse(evidence.native_receipt.occurred_at)<Date.parse(record.created_at))throw new BridgeError('action_identity_mismatch','Action evidence does not match this result, main or execution epoch','Use actual checks performed by the original main after this return',6);
  await this.artifacts(task,result.value.artifacts);await this.artifacts(task,evidence.artifacts);
  return true;
 }
 async verifyTask(actor:Actor,taskId:string,input:VerificationEvidence):Promise<TaskRecord>{
  const task=readTask(this.options.store,taskId);this.main(actor,task);const evidence=evidenceSchema.parse(input);await this.checkEvidence(actor,task,evidence);
  if(task.state==='verified')return task;
  this.options.store.db.prepare('UPDATE task_returns SET verification_json=? WHERE task_id=?').run(JSON.stringify({actor,evidence}),taskId);
  const valid=await this.options.verifyNativeAction?.(actor,evidence,'verification').catch(()=>false)??false;
  if(!valid){appendEvent(this.options.store,'verification_pending_native_evidence',taskId,{action_id:evidence.native_receipt.action_id});return task;}
  transaction(this.options.store,()=>{const seq=appendEvent(this.options.store,'task_verified',taskId,{result_sha256:evidence.result_sha256,native_call_id:evidence.native_receipt.native_call_id});this.options.store.db.prepare("UPDATE tasks SET state='verified',event_seq=? WHERE task_id=?").run(seq,taskId);this.options.store.db.prepare('UPDATE task_returns SET verified_at=? WHERE task_id=?').run(new Date().toISOString(),taskId);});return readTask(this.options.store,taskId);
 }
 async recordMainContinuation(actor:Actor,taskId:string,input:ContinuationEvidence):Promise<void>{
  const task=readTask(this.options.store,taskId);this.main(actor,task);if(this.options.store.db.prepare('SELECT task_id FROM task_cancellations WHERE task_id=?').get(taskId))throw new BridgeError('continuation_cancelled','Future work for this task was cancelled','Create an explicitly authorized new task before continuation',3);const evidence=continuationSchema.parse(input);await this.checkEvidence(actor,task,evidence);
  const verificationRow=this.options.store.db.prepare('SELECT verification_json FROM task_returns WHERE task_id=?').get(taskId);if(!verificationRow?.verification_json)throw new BridgeError('verification_missing','Main verification evidence is required before continuation','Perform and submit the actual verification first',6);const previous=JSON.parse(String(verificationRow.verification_json)) as {evidence:VerificationEvidence};if(Date.parse(evidence.native_receipt.occurred_at)<Date.parse(previous.evidence.native_receipt.occurred_at))throw new BridgeError('action_order_invalid','Continuation happened before the main verification','Use native receipts in actual execution order',6);
  const row=this.options.store.db.prepare('SELECT plan_json FROM continuation_plans WHERE task_id=?').get(taskId);if(!row)throw new BridgeError('next_action_missing','No authorized next action was recorded','Main must specify its own next action before claiming continuation',4);
  const plan=JSON.parse(String(row.plan_json)) as NextAction;if(plan.next_action_id!==evidence.next_action_id || plan.argv_sha256!==digest(evidence.command.argv))throw new BridgeError('next_action_mismatch','Executed action differs from the recorded next action','Run the exact authorized next step',6);
  await this.setBaseline(taskId);const baseline=JSON.parse(String(this.options.store.db.prepare('SELECT baseline_json FROM task_returns WHERE task_id=?').get(taskId)?.baseline_json??'{}')) as Record<string,string|null>;
  if(!plan.artifact_paths.every(path=>evidence.artifacts.some(ref=>ref.relative_path===path && ref.sha256!==baseline[path])))throw new BridgeError('no_substantive_action','Continuation requires new or changed scoped output artifacts','An empty acknowledgement or unchanged artifact is not continuation',6);
  this.options.store.db.prepare('UPDATE task_returns SET continuation_json=? WHERE task_id=?').run(JSON.stringify({actor,evidence}),taskId);
  if(task.state!=='verified' || !(await this.options.verifyNativeAction?.(actor,evidence,'continuation').catch(()=>false)??false))return;
  this.options.store.db.prepare("UPDATE task_returns SET state='main_continued' WHERE task_id=?").run(taskId);appendEvent(this.options.store,'main_continued',taskId,{next_action_id:plan.next_action_id,native_call_id:evidence.native_receipt.native_call_id});
 }
 async returnToMain(actor:Actor,taskId:string):Promise<DeliveryRecord>{
  requireActor(this.options.store,actor,'return_to_main',taskId);if(this.options.store.db.prepare('SELECT task_id FROM task_cancellations WHERE task_id=?').get(taskId))throw new BridgeError('future_delivery_cancelled','Future return notification was cancelled','Inspect the result manually; no running job was stopped',3);const task=readTask(this.options.store,taskId);if(sessionKey(actor.session)!==sessionKey(task.input.target))throw new BridgeError('scope_denied','Only the executor may prepare this return','Use the exact original task executor',3);
  const result=this.result(taskId);let record=this.getReturn(taskId)!;const already=this.deliveries.get(record.message_id);if(already)return already;await this.artifacts(task,result.value.artifacts);await this.setBaseline(taskId);
  if(!record.authority){if(!this.options.prepareReturnAuthority)throw new BridgeError('byte_return_blocked','Byte return requires the native authority handoff','Configure the pinned Byte return provider',3);const ref=await this.options.prepareReturnAuthority(actor,task,result.value,record.created_at);this.options.store.db.prepare('UPDATE task_returns SET authority_json=? WHERE task_id=? AND authority_json IS NULL').run(JSON.stringify(ref),taskId);record=this.getReturn(taskId)!;}
  this.options.store.db.prepare("UPDATE supervision SET active=0 WHERE json_extract(request_json,'$.task_id')=?").run(taskId);
  const dir=join(this.options.store.root,'.session-bridge','returns');mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,digest(taskId)+'.json'),handoff={task_id:taskId,result_sha256:result.sha256,result:result.value,return_to:task.input.return_to,return_authority:record.authority};
  if(!existsSync(path))writeFileSync(path,JSON.stringify(handoff,null,2)+'\n',{flag:'wx',mode:0o600});else if(digest(JSON.parse(readFileSync(path,'utf8')))!==digest(handoff))throw new BridgeError('return_conflict','Immutable return handoff differs','Reconcile the original result before dispatch',3);
  const prior=this.deliveries.get(record.message_id);let envelope:Envelope;
  if(prior)envelope=prior.envelope;else{const plan=this.options.store.db.prepare('SELECT plan_json FROM continuation_plans WHERE task_id=?').get(taskId);const body={text:'外部 Agent 结果回报；请原主会话独立核验，确认收到不算完成下一步。\n'+JSON.stringify({task_id:taskId,result_sha256:result.sha256,result:result.value,next_action:plan?JSON.parse(String(plan.plan_json)):null}),artifacts:result.value.artifacts};envelope={protocol_version:1,message_id:record.message_id,task_id:taskId,handoff_id:record.authority!.handoff_id,authority_epoch:record.authority!.epoch,sender:actor.session,target:task.input.return_to,kind:'return',body,body_sha256:digest(body),created_at:record.created_at,expires_at:new Date(Date.parse(record.created_at)+86400000).toISOString(),causation_id:result.sha256,correlation_id:taskId};}
  const delivery=await this.deliveries.send(actor,envelope);if(['transport_confirmed','receiver_accepted'].includes(delivery.state))this.options.store.db.prepare("UPDATE task_returns SET state='return_delivered' WHERE task_id=? AND state='return_prepared'").run(taskId);return delivery;
 }
 async reconcileActions(taskId:string):Promise<ReturnRecord|null>{
  const row=this.options.store.db.prepare('SELECT verification_json,continuation_json FROM task_returns WHERE task_id=?').get(taskId);if(!row)return null;
  if(row.verification_json){const saved=JSON.parse(String(row.verification_json)) as {actor:Actor;evidence:VerificationEvidence};await this.verifyTask(saved.actor,taskId,saved.evidence);}
  if(row.continuation_json){const saved=JSON.parse(String(row.continuation_json)) as {actor:Actor;evidence:ContinuationEvidence};await this.recordMainContinuation(saved.actor,taskId,saved.evidence);}
  const envelope=verificationReadyEnvelope(this.options.store,taskId);
  if(envelope && row.verification_json){
   const saved=JSON.parse(String(row.verification_json)) as {actor:Actor};
   const actor:Actor={...saved.actor,scope:{project_id:this.options.store.project_id,task_ids:[taskId],operations:['acknowledge_task','recover_delivery']}};
   const prior=this.deliveries.get(envelope.message_id);
   if(!prior)await this.deliveries.send(actor,envelope);
   else if(['sending','prepared','uncertain'].includes(prior.state))await this.deliveries.recover(actor,envelope.message_id);
  }
  return this.getReturn(taskId);
 }
}
