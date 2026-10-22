import { randomUUID } from 'node:crypto';
import type { Actor, Clock, DeliveryOutcome, DeliveryRecord, DeliveryState, Envelope, Observation } from '../protocol/types.js';
import { systemClock } from '../protocol/types.js';
import { digest, sessionKey } from '../protocol/canonical.js';
import { parseEnvelope } from '../protocol/schema.js';
import { BridgeError } from '../protocol/errors.js';
import { appendEvent, transaction, type BridgeStore } from './database.js';
import { BindingService } from './bindings.js';
import { exactBinding, readTask, requireActor, TaskService } from './tasks.js';
import { verifyArtifact } from './artifacts.js';
import { StandaloneWorkflow } from '../workflows/standalone.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { AuthorityProvider } from '../workflows/contract.js';
import type { NativeRoute } from '../adapters/contract.js';
import { chooseRoute } from './router.js';
import { verificationReadyEnvelope } from '../return/wakeup.js';
function decode(row:Record<string,unknown>):DeliveryRecord{return {message_id:String(row.message_id),state:row.state as DeliveryState,envelope:JSON.parse(String(row.envelope_json)),input_sha256:String(row.input_sha256),event_seq:Number(row.event_seq),native_receipt:row.native_receipt===null?null:String(row.native_receipt),reason:row.reason===null?null:String(row.reason)};}
export class DeliveryService {
 private clock:Clock;
 constructor(private store:BridgeStore,private adapters:AdapterRegistry,private options:{clock?:Clock;native?:NativeRoute;workflow?:AuthorityProvider}={}){this.clock=options.clock??systemClock;}
 get(messageId:string):DeliveryRecord|null {const row=this.store.db.prepare('SELECT * FROM deliveries WHERE message_id=?').get(messageId);return row?decode(row):null;}
 async send(actor:Actor,input:Envelope):Promise<DeliveryRecord>{
  const envelope=parseEnvelope(input),operation=envelope.kind==='verification_ready'?'acknowledge_task':envelope.kind==='supervision'?'request_supervision':envelope.kind==='task'?'delegate_task':envelope.kind==='return'?'return_to_main':'report_result';
  requireActor(this.store,actor,operation,envelope.task_id,this.clock);
  const task=readTask(this.store,envelope.task_id);
  let authority=task.input.authority;
  if(['return','main_ack','verification_ready'].includes(envelope.kind)){const row=this.store.db.prepare('SELECT authority_json FROM task_returns WHERE task_id=?').get(task.task_id);if(!row?.authority_json)throw new BridgeError('return_authority_missing','Return authority was not prepared','Prepare the immutable return before dispatch',3);authority=JSON.parse(String(row.authority_json));}
  if(envelope.kind==='verification_ready'){
   const expected=verificationReadyEnvelope(this.store,task.task_id);
   if(!expected || digest(expected)!==digest(envelope))throw new BridgeError('scope_denied','Continuation notice has no exact verified action and fixed plan','Use the durable native-verification observer',3);
  }
  if(sessionKey(actor.session)!==sessionKey(envelope.sender) || envelope.sender.project_id!==this.store.project_id || envelope.target.project_id!==this.store.project_id || envelope.authority_epoch!==authority.epoch || envelope.handoff_id!==authority.handoff_id)throw new BridgeError('scope_denied','Envelope identity or authority does not match its task','Reconcile exact session, handoff and authority epoch',3);
  const expectedSender=envelope.kind==='supervision'?task.input.source:envelope.kind==='task'?task.input.source:['main_ack','verification_ready'].includes(envelope.kind)?task.input.return_to:task.input.target;
  let expectedTarget=envelope.kind==='task' || envelope.kind==='main_ack'?task.input.target:task.input.return_to;
  if(envelope.kind==='supervision'){const event=this.store.db.prepare('SELECT lease_id,message_id FROM run_events WHERE event_id=?').get(envelope.causation_id??'');const lease=event?this.store.db.prepare('SELECT request_json,active FROM supervision WHERE id=?').get(String(event.lease_id)):undefined;const request=lease?JSON.parse(String(lease.request_json)):null;if(!lease?.active || event?.message_id!==envelope.message_id || request.task_id!==task.task_id)throw new BridgeError('scope_denied','Supervision message has no exact active event lease','Use the registered checker',3);expectedTarget=request.supervisor;}
  if(sessionKey(envelope.sender)!==sessionKey(expectedSender) || sessionKey(envelope.target)!==sessionKey(expectedTarget))throw new BridgeError('scope_denied','Message participants do not match the task route','Use the original task participants',3);
  if(authority.workflow==='byte'){const check=await this.options.workflow?.reconcileHandoff?.(authority);if(check?.state!=='granted')throw new BridgeError('byte_authority_unconfirmed','Current Byte transport authority cannot be verified','Configure the pinned Byte provider and reconcile this exact handoff before dispatch',3);}
  const fingerprint=digest(envelope),prior=this.get(envelope.message_id);
  if(prior){if(prior.input_sha256!==fingerprint)throw new BridgeError('message_id_conflict','Same message ID has different content or target','Use the original immutable envelope');return prior;}
  if(task.state==='cancelled' || this.store.db.prepare('SELECT task_id FROM task_cancellations WHERE task_id=?').get(task.task_id))throw new BridgeError('future_delivery_cancelled','Future delivery for this task was cancelled','Inspect the existing run/result; cancellation does not stop its job',3);
  if(Date.parse(envelope.expires_at)<=this.clock.now().getTime())throw new BridgeError('expired_message','Message is expired','Review the task before preparing a new message');
  for(const ref of envelope.body.artifacts)if(!await verifyArtifact(this.store.root,ref))throw new BridgeError('invalid_artifact','Artifact path or digest is invalid','Verify the original artifact inside the project',6);
  const target=await exactBinding(this.store,envelope.target,this.clock),adapter=this.adapters.get(target.identity.harness);
  const route=chooseRoute({source:actor.session,target,native:this.options.native,adapter_id:adapter?target.identity.harness:null});
  if(route.kind==='blocked')throw new BridgeError('route_blocked',route.reason??'No delivery route','Connect a supported native host or adapter',3);
  const holder=randomUUID();
  const acquired=transaction(this.store,()=>{
   const existing=this.get(envelope.message_id);
   if(existing){if(existing.input_sha256!==fingerprint)throw new BridgeError('message_id_conflict','Same message ID has different content','Keep the original immutable envelope');return false;}
   requireActor(this.store,actor,operation,envelope.task_id,this.clock);
   if(readTask(this.store,task.task_id).state==='cancelled' || this.store.db.prepare('SELECT task_id FROM task_cancellations WHERE task_id=?').get(task.task_id))throw new BridgeError('future_delivery_cancelled','Future delivery was cancelled before its first intent','No native delivery was attempted',3);
   if(envelope.kind==='verification_ready' && digest(verificationReadyEnvelope(this.store,task.task_id))!==fingerprint)throw new BridgeError('scope_denied','Verified action changed before notification','Do not enqueue a stale continuation notice',3);
   const currentTarget=new BindingService(this.store,this.clock).get(target.binding_id);
   if(!currentTarget || !new BindingService(this.store,this.clock).isUsable(target.binding_id) || sessionKey(currentTarget.identity)!==sessionKey(envelope.target))throw new BridgeError('target_unbound','Target generation changed before dispatch','Reconnect the exact target; no native delivery was attempted',3);
   if(Date.parse(envelope.expires_at)<=this.clock.now().getTime())throw new BridgeError('expired_message','Message expired before its first intent','Review the task scope',3);
   const seq=appendEvent(this.store,'delivery_intent',envelope.message_id,{task_id:envelope.task_id,route_id:route.route_id,input_sha256:fingerprint},this.clock.now().toISOString());
   this.store.db.prepare('INSERT INTO deliveries(message_id,task_id,envelope_json,input_sha256,state,event_seq,route_id,lease_holder,lease_until) VALUES (?,?,?,?,?,?,?,?,?)').run(envelope.message_id,envelope.task_id,JSON.stringify(envelope),fingerprint,'sending',seq,route.route_id,holder,new Date(this.clock.now().getTime()+30_000).toISOString());
   return true;
  });
  if(!acquired)return this.get(envelope.message_id)!;
  let outcome:DeliveryOutcome;
  try{outcome=route.kind==='native'?await this.options.native!.deliver(actor,envelope):await adapter!.deliver(envelope);}catch{outcome={state:'uncertain',reason:'Delivery outcome is unknown; reconcile before retrying'};}
  transaction(this.store,()=>{
   const seq=appendEvent(this.store,'delivery_outcome',envelope.message_id,{state:outcome.state},this.clock.now().toISOString());
   const state=outcome.state==='confirmed'?'transport_confirmed':outcome.state;
   this.store.db.prepare("UPDATE deliveries SET state=CASE WHEN state IN ('sending','prepared','uncertain') THEN ? ELSE state END,native_receipt=COALESCE(?,native_receipt),reason=?,event_seq=?,lease_holder=NULL,lease_until=NULL WHERE message_id=? AND lease_holder=?").run(state,outcome.state==='confirmed'?outcome.native_receipt:null,outcome.state==='confirmed'?null:outcome.reason,seq,envelope.message_id,holder);
  });
  return this.get(envelope.message_id)!;
 }
 async recover(actor:Actor,messageId:string):Promise<DeliveryRecord>{
  const record=this.get(messageId);
  if(!record)throw new BridgeError('delivery_missing','No durable intent exists for this message','Select an existing delivery; recovery does not send a new message',3);
  requireActor(this.store,actor,'recover_delivery',record.envelope.task_id,this.clock);
  const task=readTask(this.store,record.envelope.task_id);
  if(![task.input.source,task.input.target,task.input.return_to].some(s=>sessionKey(s)===sessionKey(actor.session)))throw new BridgeError('scope_denied','Session is not part of this delivery','Use an original task participant',3);
  const route=this.store.db.prepare('SELECT route_id FROM deliveries WHERE message_id=?').get(messageId)?.route_id;
  let observations:Observation[]=[];
  try{if(String(route).startsWith('native:'))observations=await this.options.native?.reconcile?.(record.envelope)??[];else observations=await this.adapters.get(record.envelope.target.harness)?.reconcile(record.envelope)??[];}catch{observations=[];}
  const valid=observations.filter(o=>o.message_id===messageId && sessionKey(o.session)===sessionKey(record.envelope.target) && o.state!=='unknown' && o.native_receipt);
  transaction(this.store,()=>{
   const current=this.get(messageId)!;
   const received=valid.some(o=>o.state!=='queued');
   const next=received?'receiver_accepted':valid.length && current.state!=='receiver_accepted'?'transport_confirmed':['prepared','sending'].includes(current.state)?'uncertain':current.state;
   const seq=appendEvent(this.store,'delivery_reconciled',messageId,{state:next,observations:valid},this.clock.now().toISOString());
   this.store.db.prepare('UPDATE deliveries SET state=?,native_receipt=COALESCE(?,native_receipt),reason=?,event_seq=? WHERE message_id=?').run(next,valid[0]?.native_receipt??null,next==='uncertain'?'No conclusive native evidence; no resend performed':current.reason,seq,messageId);
  });
  if(actor.scope.operations.includes('get_task_status'))for(const observation of valid)await new TaskService(this.store,new StandaloneWorkflow(),this.clock).observe(actor,task.task_id,observation);
  return this.get(messageId)!;
 }
}
