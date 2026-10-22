import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Actor, Clock, Observation, SessionIdentity, TaskInput, TaskRecord, TaskState } from '../protocol/types.js';
import { systemClock } from '../protocol/types.js';
import { digest, sessionKey } from '../protocol/canonical.js';
import { taskInputSchema } from '../protocol/schema.js';
import { BridgeError } from '../protocol/errors.js';
import { appendEvent, transaction, type BridgeStore } from './database.js';
import { BindingService } from './bindings.js';
import type { AuthorityProvider } from '../workflows/contract.js';
export function requireActor(store:BridgeStore,actor:Actor,operation:string,taskId?:string,clock:Clock=systemClock):void {
 const service=new BindingService(store,clock),binding=service.get(actor.binding_id);
 if(!binding || !service.isUsable(binding.binding_id) || sessionKey(binding.identity)!==sessionKey(actor.session) || actor.scope.project_id!==store.project_id || !actor.scope.operations.includes(operation) || (taskId && !actor.scope.task_ids.includes('*') && !actor.scope.task_ids.includes(taskId)))throw new BridgeError('scope_denied','Session or operation is not in the granted scope','Reconnect the exact session with the required project/task permission',3);
}
export function readTask(store:BridgeStore,id:string):TaskRecord {
 const row=store.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
 if(!row)throw new BridgeError('task_missing','Task does not exist in this project','Select an existing task',3);
 return {task_id:String(row.task_id),state:row.state as TaskState,input:JSON.parse(String(row.input_json)),input_sha256:String(row.input_sha256),event_seq:Number(row.event_seq)};
}
export async function exactBinding(store:BridgeStore,identity:SessionIdentity,clock:Clock=systemClock){
 const records=await new BindingService(store,clock).resolve({query:'',project_id:store.project_id,harness:identity.harness,profile_id:identity.profile_id});
 const match=records.find(b=>sessionKey(b.identity)===sessionKey(identity));
 if(!match)throw new BridgeError('target_unbound','Exact native session generation is not connected','Reconnect or choose the exact target; never fall back to latest',3);
 return match;
}
export class TaskService {
 constructor(private store:BridgeStore,private authority:AuthorityProvider,private clock:Clock=systemClock){}
 async create(actor:Actor,input:TaskInput,reservedId?:string):Promise<TaskRecord>{
  requireActor(this.store,actor,'delegate_task',undefined,this.clock);
  const parsed=taskInputSchema.safeParse(input);
  if(!parsed.success)throw new BridgeError('invalid_task','Invalid task scope or acceptance','Supply a goal, acceptance, path scope and deadline');
  input=parsed.data;
  if(sessionKey(actor.session)!==sessionKey(input.source) || input.source.project_id!==this.store.project_id || input.target.project_id!==this.store.project_id || input.return_to.project_id!==this.store.project_id || input.source.host_id!==input.target.host_id)throw new BridgeError('scope_denied','Task participants do not match this local project','Connect all participants to the same local project',3);
  if(Date.parse(input.deadline_at)<=this.clock.now().getTime())throw new BridgeError('expired_task','Task deadline has passed','Specify a future deadline');
  for(const path of [...input.read_paths,...input.write_paths])if(isAbsolute(path) || path.split(/[\\/]/).includes('..'))throw new BridgeError('path_out_of_scope','Task paths must stay inside the project','Use project-relative paths');
  await exactBinding(this.store,input.target,this.clock);await exactBinding(this.store,input.return_to,this.clock);
  const check=await (this.authority.authorizeDelegation?.(actor,input.authority,input)??this.authority.check(actor,input.authority,input));
  if(check.state!=='granted')throw new BridgeError('authority_denied',check.reason??'Task work authority is not confirmed','Reconcile the current workflow owner before creating work',3);
  return transaction(this.store,()=>{
   if(reservedId){const prior=this.store.db.prepare('SELECT input_sha256 FROM tasks WHERE task_id=?').get(reservedId);if(prior){if(prior.input_sha256!==digest(input))throw new BridgeError('task_id_conflict','Reserved task has different immutable scope','Reconcile the original request',3);return readTask(this.store,reservedId);}}
   if(input.authority.workflow==='byte'){const prior=this.store.db.prepare("SELECT task_id,input_sha256 FROM tasks WHERE json_extract(input_json,'$.authority.workflow')='byte' AND json_extract(input_json,'$.authority.handoff_id')=?").get(input.authority.handoff_id);if(prior){if(prior.input_sha256!==digest(input))throw new BridgeError('handoff_scope_conflict','Byte handoff already belongs to another immutable task','Reconcile the existing task',3);return readTask(this.store,String(prior.task_id));}}
   const task_id=reservedId??randomUUID(),input_sha256=digest(input),event_seq=appendEvent(this.store,'task_ready',task_id,{input_sha256},this.clock.now().toISOString());
   this.store.db.prepare('INSERT INTO tasks(task_id,state,input_json,input_sha256,event_seq) VALUES (?,?,?,?,?)').run(task_id,'ready',JSON.stringify(input),input_sha256,event_seq);
   return {task_id,state:'ready',input,input_sha256,event_seq};
  });
 }
 get(actor:Actor,id:string):TaskRecord {
  requireActor(this.store,actor,'get_task_status',id,this.clock);const task=readTask(this.store,id);
  if(![task.input.source,task.input.target,task.input.return_to].some(s=>sessionKey(s)===sessionKey(actor.session)) && !this.store.db.prepare("SELECT request_json FROM supervision WHERE active=1 AND json_extract(request_json,'$.task_id')=?").all(id).some(row=>{const lease=JSON.parse(String(row.request_json));return Date.parse(lease.deadline_at)>this.clock.now().getTime() && sessionKey(lease.supervisor)===sessionKey(actor.session);}))throw new BridgeError('scope_denied','Session is not a task participant','Use the task source, target or return session',3);
  return task;
 }
 async observe(actor:Actor,id:string,observation:Observation):Promise<TaskRecord>{
  const task=this.get(actor,id);
  return transaction(this.store,()=>{
   const row=this.store.db.prepare('SELECT envelope_json FROM deliveries WHERE message_id=? AND task_id=?').get(observation.message_id,id);
   if(!row)return task;
   const envelope=JSON.parse(String(row.envelope_json)) as {target:SessionIdentity;authority_epoch:number};
   if(sessionKey(observation.session)!==sessionKey(envelope.target) || envelope.authority_epoch!==task.input.authority.epoch)return task;
   const rank:Partial<Record<TaskState,number>>={ready:0,accepted:1,running:2,result_reported:3,verified:4};
   const desired:Partial<Record<Observation['state'],TaskState>>={accepted:'accepted',running:'running',completed:'result_reported'};
   const next=desired[observation.state];
   if(!next || !observation.native_receipt || rank[task.state]===undefined || rank[next]!<=rank[task.state]!)return task;
   const seq=appendEvent(this.store,'task_observed',id,{message_id:observation.message_id,state:next,native_receipt:observation.native_receipt,artifacts:observation.artifacts},this.clock.now().toISOString());
   this.store.db.prepare('UPDATE tasks SET state=?,event_seq=? WHERE task_id=?').run(next,seq,id);
   return {...task,state:next,event_seq:seq};
  });
 }
}
