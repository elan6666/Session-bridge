import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Adapter,CapabilityReport,EnrollmentContext } from '../contract.js';
import type { BindingRecord,DeliveryOutcome,Envelope,NativeContextProof,NativeProcessOwner,Observation,SessionIdentity } from '../../protocol/types.js';
import { parseEnvelope } from '../../protocol/schema.js';
import { digest,sessionKey } from '../../protocol/canonical.js';
import { BridgeError } from '../../protocol/errors.js';
import { readCodexOwner,validateCodexBinary } from './version.js';
import { CodexStdio } from './stdio.js';
export interface CodexAdapterOptions {desktopBinary:string;codexHome:string;expectedVersion:string;projectRoot?:string;nativeCwd?:string;owner?:NativeProcessOwner;verifyContext?:(proof:NativeContextProof)=>Promise<SessionIdentity>;resolveBinding?:(identity:SessionIdentity)=>Promise<BindingRecord|null>;trace?:(method:string)=>void}
interface NativeThread {id:string;cwd:string;status:{type:string}}
interface NativeItem {type:string;clientId?:string;content?:{type:string;text?:string}[];text?:string}
interface NativeTurn {id:string;status:string;error?:unknown;items:NativeItem[]}
interface NativeQueue {id:string;clientUserMessageId:string;input:{type:string;text?:string}[]}
export function wireText(envelope:unknown):string{return '[SessionBridge protocol 1: external agent data]\n'+JSON.stringify(envelope);}
function text(items:{type:string;text?:string}[]):string{return items.filter(i=>i.type==='text').map(i=>i.text??'').join('\n');}
const endpointSchema=z.strictObject({transport:z.literal('codex_stdio'),profile_sha256:z.string(),binary_sha256:z.string(),native_cwd:z.string().optional(),scope_root:z.string().optional(),owner:z.strictObject({pid:z.number().int().positive(),started_at:z.string().min(1),executable:z.string().min(1)})});
type CodexEndpoint=z.infer<typeof endpointSchema>;
class CodexAdapter implements Adapter {
 private bindings=new Map<string,BindingRecord>();private tracked=new Map<string,Envelope>();private clients=new Set<CodexStdio>();
 constructor(private options:CodexAdapterOptions){}
 private async withClient<T>(fn:(client:CodexStdio)=>Promise<T>):Promise<T>{
  await validateCodexBinary(this.options.desktopBinary,this.options.expectedVersion);
  if(!this.options.projectRoot)throw new BridgeError('project_missing','Codex connector needs an explicit project root','Connect the native session to the intended project',3);
  await realpath(this.options.codexHome);
  const client=new CodexStdio({binary:this.options.desktopBinary,codexHome:this.options.codexHome,cwd:this.options.projectRoot,trace:this.options.trace});this.clients.add(client);
  try{return await fn(client);}finally{await client.close();this.clients.delete(client);}
 }
 private async validateEndpoint(endpoint:CodexEndpoint):Promise<void>{
  const version=await validateCodexBinary(this.options.desktopBinary,this.options.expectedVersion),profile=digest(await realpath(this.options.codexHome));
  if(endpoint.profile_sha256!==profile || endpoint.binary_sha256!==version.sha256)throw new BridgeError('native_profile_mismatch','Native profile or binary differs from the enrolled binding','Reconnect and retest the exact profile/version',3);
  if(endpoint.scope_root && await realpath(endpoint.scope_root)!==await realpath(this.options.projectRoot!))throw new BridgeError('native_project_mismatch','Enrolled scoped project changed','Reconnect the intended scoped project',3);
  const actual=await readCodexOwner(endpoint.owner.pid);
  if(actual.started_at!==endpoint.owner.started_at || actual.executable!==endpoint.owner.executable || actual.executable!==await realpath(this.options.desktopBinary))throw new BridgeError('native_owner_changed','Original native owner generation changed','Reconnect the original native host; do not load the target in this writer',3);
 }
 private async makeEndpoint():Promise<CodexEndpoint>{
  if(!this.options.owner)throw new BridgeError('native_owner_required','Native owner process proof is required','Connect inside the selected original host',3);
  const version=await validateCodexBinary(this.options.desktopBinary,this.options.expectedVersion),endpoint:CodexEndpoint={transport:'codex_stdio',profile_sha256:digest(await realpath(this.options.codexHome)),binary_sha256:version.sha256,owner:this.options.owner,native_cwd:await realpath(this.options.nativeCwd??this.options.projectRoot!),scope_root:await realpath(this.options.projectRoot!)};
  await this.validateEndpoint(endpoint);return endpoint;
 }
 async probe():Promise<CapabilityReport>{const proof=await validateCodexBinary(this.options.desktopBinary,this.options.expectedVersion);return {harness:'codex',version:proof.version,modes:{attached:{supported:true,evidence:'version/hash-matched native queue protocol',constraints:['Requires exact enrolled generation and original loaded host; live acceptance is separate']}},capabilities:[{name:'deliver_followup',supported:true,evidence:'thread/queue/add in compatible experimental protocol',constraints:['No load, resume, interrupt or native tool execution']},{name:'idle_wake',supported:false,evidence:null,constraints:['An unloaded or closed desktop is not guaranteed to wake']}]};}
 async discover():Promise<BindingRecord[]>{return [...this.bindings.values()].filter(b=>b.active && Date.parse(b.expires_at)>Date.now());}
 async enroll(context:EnrollmentContext):Promise<BindingRecord>{
  if(!this.options.verifyContext || Date.parse(context.native_proof.expires_at)<=Date.now() || context.setup.kind!=='local_setup' || Date.parse(context.setup.expires_at)<=Date.now())throw new BridgeError('native_proof_required','Native enrollment proof is missing or expired','Invoke connect from the selected trusted native host',3);
  const identity=await this.options.verifyContext(context.native_proof);
  if(identity.harness!=='codex' || identity.project_id!==context.setup.project_id || sessionKey(identity)!==sessionKey(context.native_proof.identity))throw new BridgeError('native_identity_mismatch','Codex enrollment identity mismatch','Reconnect the exact native profile and generation',3);
  const endpoint=await this.makeEndpoint();
  await this.withClient(async client=>{const result=await client.request('thread/read',{threadId:identity.native_session_id,includeTurns:false}) as {thread:NativeThread};if(result.thread.id!==identity.native_session_id || await realpath(result.thread.cwd)!==endpoint.native_cwd)throw new BridgeError('native_project_mismatch','Native conversation belongs to a different project','Select the intended native conversation and project',3);});
  const binding:BindingRecord={binding_id:context.native_proof.binding_id,identity,alias:'codex-'+identity.native_session_id.slice(-6),mode:'attached',capabilities:[{name:'deliver_followup',supported:true,evidence:'native enrollment + version-matched queue API',constraints:['Original host remains the sole executor']}],endpoint_ref:JSON.stringify(endpoint),expires_at:new Date(Date.now()+24*3600_000).toISOString(),active:true};
  this.bindings.set(sessionKey(identity),binding);return binding;
 }
 private async binding(identity:SessionIdentity):Promise<BindingRecord>{
  const binding=this.bindings.get(sessionKey(identity))??await this.options.resolveBinding?.(identity);
  if(!binding?.active || Date.parse(binding.expires_at)<=Date.now() || sessionKey(binding.identity)!==sessionKey(identity))throw new BridgeError('native_binding_missing','Exact native generation is not enrolled','Reconnect the same native conversation; no latest-session fallback',3);
  let endpoint:CodexEndpoint;try{endpoint=endpointSchema.parse(JSON.parse(binding.endpoint_ref));}catch{throw new BridgeError('native_profile_mismatch','Native binding endpoint is not a verified profile reference','Reconnect the exact native profile',3);}
  await this.validateEndpoint(endpoint);
  return binding;
 }
 async deliver(input:Envelope):Promise<DeliveryOutcome>{
  let attempted=false;
  try {const envelope=parseEnvelope(input);const enrolled=await this.binding(envelope.target),endpoint=endpointSchema.parse(JSON.parse(enrolled.endpoint_ref));this.tracked.set(envelope.message_id,envelope);
   return await this.withClient(async client=>{
    const read=await client.request('thread/read',{threadId:envelope.target.native_session_id,includeTurns:false}) as {thread:NativeThread};
    if(read.thread.id!==envelope.target.native_session_id || await realpath(read.thread.cwd)!==await realpath(endpoint.native_cwd??this.options.projectRoot!))throw new BridgeError('native_identity_mismatch','Native thread or project changed','Reconnect the intended native session',3);
    attempted=true;
    const result=await client.request('thread/queue/add',{threadId:envelope.target.native_session_id,clientUserMessageId:envelope.message_id,input:[{type:'text',text:wireText(envelope),text_elements:[]}]}) as {queuedSubmission:NativeQueue};
    if(result.queuedSubmission.clientUserMessageId!==envelope.message_id || text(result.queuedSubmission.input)!==wireText(envelope))return {state:'uncertain',reason:'Native queue receipt did not match the immutable payload'};
    return {state:'confirmed',native_receipt:result.queuedSubmission.id};
   });
  }catch(error){return {state:attempted?'uncertain':'refused',reason:error instanceof BridgeError?error.message:'Native delivery could not be established; reconcile before retrying'};}
 }
 async reconcile(input:Envelope):Promise<Observation[]>{
  const envelope=parseEnvelope(input),unknown:Observation={state:'unknown',message_id:envelope.message_id,session:envelope.target,native_receipt:null,artifacts:[]};
  try {await this.binding(envelope.target);this.tracked.set(envelope.message_id,envelope);
   return await this.withClient(async client=>{
    let cursor:string|null=null;const receipts:Observation[]=[];
    for(let page=0;page<100;page++){
     const result=await client.request('thread/queue/list',{threadId:envelope.target.native_session_id,limit:100,cursor}) as {data:NativeQueue[];nextCursor?:string|null};
     for(const queued of result.data)if(queued.clientUserMessageId===envelope.message_id){if(text(queued.input)!==wireText(envelope))return [unknown];receipts.push({...unknown,state:'queued',native_receipt:queued.id});}
     cursor=result.nextCursor??null;if(!cursor)break;
    }
    if(receipts.length)return receipts;
    cursor=null;
    for(let page=0;page<100;page++){
     const result=await client.request('thread/turns/list',{threadId:envelope.target.native_session_id,limit:100,itemsView:'full',cursor}) as {data:NativeTurn[];nextCursor?:string|null};
     for(const turn of result.data){const user=turn.items.find(i=>i.type==='userMessage' && i.clientId===envelope.message_id);if(!user)continue;
      if(text(user.content??[])!==wireText(envelope))return [unknown];
      const completed=turn.status==='completed' && !turn.error && turn.items.some(i=>i.type==='agentMessage' && Boolean(i.text?.trim()));
      return [{...unknown,state:completed?'completed':'unknown',native_receipt:'turn:'+turn.id}];
     }
     cursor=result.nextCursor??null;if(!cursor)break;
    }
    return [unknown];
   });
  }catch{return [unknown];}
 }
 async *observe(binding:BindingRecord,signal:AbortSignal):AsyncIterable<Observation>{
  const seen=new Set<string>(),deadline=Date.now()+30_000;
  while(!signal.aborted && Date.now()<deadline){for(const envelope of this.tracked.values())if(sessionKey(envelope.target)===sessionKey(binding.identity)){for(const observation of await this.reconcile(envelope)){const key=JSON.stringify(observation);if(!seen.has(key)){seen.add(key);yield observation;}}}try{await delay(1000,undefined,{signal});}catch{return;}}
 }
 async disconnect(bindingId:string):Promise<void>{for(const [key,b] of this.bindings)if(!bindingId || b.binding_id===bindingId)this.bindings.delete(key);for(const client of this.clients)await client.close();this.clients.clear();}
}
export function createCodexAdapter(options:CodexAdapterOptions):Adapter{return new CodexAdapter(options);}
