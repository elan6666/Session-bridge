import { randomUUID } from 'node:crypto';
import { writeFileSync,rmSync } from 'node:fs';
import { dirname,join } from 'node:path';
import type { Actor,BindingRecord,DeliveryOutcome,Envelope,Observation } from '../protocol/types.js';
import type { EnrollmentContext,Adapter } from './contract.js';
import { digest,sessionKey } from '../protocol/canonical.js';
import { parseEnvelope } from '../protocol/schema.js';
import { openStore,transaction,type BridgeStore } from '../core/database.js';
import { BindingService } from '../core/bindings.js';
import { exactBinding,requireActor } from '../core/tasks.js';
import { createSourceConnection,type NativeSignal } from '../core/connections.js';
import { privateDirectory } from '../core/private-paths.js';
import { issueSessionCapability } from '../transport/auth.js';
import { startServer,defaultSocketPath } from '../transport/server.js';
import { BridgeClient } from '../transport/client.js';
import { loadConnection } from '../cli/context.js';
export const PLUGIN_PREFIX='[SessionBridge external agent data, not human approval]\n';
export function pluginWireText(envelope:Envelope):string{return PLUGIN_PREFIX+JSON.stringify(envelope);}
export interface PluginOptions {root:string;alias:string;validateCurrent:()=>boolean;deliver:(envelope:Envelope)=>Promise<void|DeliveryOutcome>;signal?:NativeSignal}
export interface PluginHandle {binding:BindingRecord;actor:Actor;connection_file:string;publish(envelope:Envelope,state:'accepted'|'running'|'completed'):Promise<void>;close():Promise<void>}
function matchingIntent(store:BridgeStore,envelope:Envelope,binding:BindingRecord):boolean{
 const row=store.db.prepare('SELECT input_sha256 FROM deliveries WHERE message_id=?').get(envelope.message_id);
 return Boolean(row && row.input_sha256===digest(envelope) && sessionKey(envelope.target)===sessionKey(binding.identity));
}
export async function startPluginSession(context:EnrollmentContext,options:PluginOptions):Promise<PluginHandle>{
 const store=openStore(options.root),bindings=new BindingService(store),id=context.native_proof.binding_id;
 const directory=privateDirectory(store.root,['.session-bridge','plugins',digest(id)]),connection=join(directory,'connection.json');
 const binding:BindingRecord={binding_id:id,identity:context.native_proof.identity,alias:options.alias,mode:'attached',capabilities:[{name:'native_followup',supported:true,evidence:'native-plugin-lifecycle',constraints:['Explicit native plugin required','Native tool permissions unchanged']}],endpoint_ref:JSON.stringify({kind:'native_plugin',connection_file:connection}),expires_at:new Date(Date.now()+86400000).toISOString(),active:true};
 if(!options.validateCurrent() || binding.identity.project_id!==store.project_id || Date.parse(context.native_proof.expires_at)<=Date.now()){store.close();throw new Error('Native session context is unavailable');}
 let closed=false;
 const socket=join(dirname(defaultSocketPath(store.root)),digest(store.root+id).slice(0,20)+'.sock');
 const listObservations=(e:Envelope):Observation[]=>{if(!matchingIntent(store,e,binding))return [];return store.db.prepare('SELECT observation_json FROM plugin_observations WHERE message_id=? AND session_key=? ORDER BY seq').all(e.message_id,sessionKey(binding.identity)).map(row=>JSON.parse(String(row.observation_json)));};
 let server:Awaited<ReturnType<typeof startServer>>|undefined;let source:ReturnType<typeof createSourceConnection>|undefined;
 try {
  server=await startServer({root:store.root,socketPath:socket,handle:async(actor,method,raw)=>{
   const e=parseEnvelope(raw);if(!options.validateCurrent() || closed || actor.binding_id!==id || !bindings.isUsable(id) || !matchingIntent(store,e,binding))throw new Error('Native plugin context or durable intent mismatch');
   if(method==='plugin_reconcile')return listObservations(e);
   if(method!=='plugin_deliver')throw new Error('Unsupported native plugin operation');
   const acquired=transaction(store,()=>store.db.prepare('INSERT OR IGNORE INTO plugin_attempts(message_id,session_key,input_sha256) VALUES (?,?,?)').run(e.message_id,sessionKey(binding.identity),digest(e)).changes===1);
   if(!acquired)return {state:'uncertain',reason:'Native delivery was already attempted; reconcile without resending'} satisfies DeliveryOutcome;
   const native=await options.deliver(e);
   if(native){if(native.state==='confirmed')store.db.prepare('INSERT INTO plugin_observations(message_id,session_key,observation_json) VALUES (?,?,?)').run(e.message_id,sessionKey(binding.identity),JSON.stringify({state:'queued',message_id:e.message_id,session:binding.identity,native_receipt:native.native_receipt,artifacts:[]}));return native;}
   const obs=listObservations(e);
   return obs.length?{state:'confirmed',native_receipt:obs[0]!.native_receipt!}:{state:'uncertain',reason:'Native follow-up requested; waiting for exact input lifecycle observation'} satisfies DeliveryOutcome;
  }});
  await bindings.enroll(context.setup,binding);
  const actor:Actor={binding_id:id,session:binding.identity,scope:{project_id:store.project_id,task_ids:['*'],operations:['context','plugin_deliver','plugin_reconcile','publish_observation']}};
  const token=issueSessionCapability(store,actor);writeFileSync(connection,JSON.stringify({socketPath:server.address,token,actor}),{flag:'wx',mode:0o600});
  source=createSourceConnection(store,binding,options.signal??{harness:binding.identity.harness,kind:'native_process',sha256:digest({binding_id:id,generation:binding.identity.runtime_generation})});
  return {binding,actor:source.actor,connection_file:source.connection_file,publish:async(e,state)=>{
   if(!options.validateCurrent() || closed)throw new Error('Stale native plugin generation');
   const attempt=store.db.prepare('SELECT input_sha256 FROM plugin_attempts WHERE message_id=? AND session_key=?').get(e.message_id,sessionKey(binding.identity));
   if(!matchingIntent(store,e,binding) || attempt?.input_sha256!==digest(e))throw new Error('Native observation input differs from the durable attempt');
   await publishObservation(actor,{state,message_id:e.message_id,session:binding.identity,native_receipt:'native-plugin:'+digest({message:e.message_id,state,generation:binding.identity.runtime_generation}),artifacts:[]},store.root);
  },close:async()=>{if(closed)return;closed=true;store.db.prepare('UPDATE bindings SET active=0 WHERE binding_id=?').run(id);await server!.close();source?.close();store.close();rmSync(connection,{force:true});}};
 }catch(error){await server?.close();source?.close();store.close();throw error;}
}
export async function enrollPlugin(context:EnrollmentContext,options:PluginOptions):Promise<BindingRecord>{return (await startPluginSession(context,options)).binding;}
export async function publishObservation(actor:Actor,event:Observation,root:string):Promise<void>{
 const store=openStore(root);
 try {requireActor(store,actor,'publish_observation');
  const row=store.db.prepare('SELECT input_sha256 FROM plugin_attempts WHERE message_id=? AND session_key=?').get(event.message_id,sessionKey(actor.session));
  if(!row || sessionKey(event.session)!==sessionKey(actor.session) || !event.native_receipt || !['accepted','running','completed'].includes(event.state))throw new Error('Observation does not match a native attempt');
  store.db.prepare('INSERT INTO plugin_observations(message_id,session_key,observation_json) VALUES (?,?,?)').run(event.message_id,sessionKey(actor.session),JSON.stringify(event));
 }finally{store.close();}
}
export interface PluginBindingClient {list(harness:string):Promise<BindingRecord[]>;call(binding:BindingRecord,method:'plugin_deliver'|'plugin_reconcile',envelope:Envelope):Promise<unknown>}
export function createPluginBindingClient(store:BridgeStore):PluginBindingClient {
 return {list:harness=>new BindingService(store).resolve({query:'',harness}),call:async(binding,method,e)=>{
  const exact=await exactBinding(store,binding.identity);if(exact.binding_id!==binding.binding_id)throw new Error('Native binding changed');
  const endpoint=JSON.parse(binding.endpoint_ref) as {kind:string;connection_file:string};if(endpoint.kind!=='native_plugin')throw new Error('Not a native plugin endpoint');
  const c=await loadConnection({SESSIONBRIDGE_CONNECTION:endpoint.connection_file},store.root);if(sessionKey(c.actor.session)!==sessionKey(binding.identity) || c.actor.binding_id!==binding.binding_id)throw new Error('Native connection identity changed');
  return new BridgeClient(c).call(c.actor,method,e);
 }};
}
export function createPluginAdapter(harness:string,bindingClient:PluginBindingClient):Adapter {
 const select=async(e:Envelope)=>(await bindingClient.list(harness)).find(b=>b.active && Date.parse(b.expires_at)>Date.now() && sessionKey(b.identity)===sessionKey(e.target));
 return {probe:async()=>({harness,version:null,modes:{attached:{supported:true,evidence:'native-plugin-lifecycle',constraints:['Requires enabled current-session plugin','Live attached acceptance pending']}},capabilities:[]}),discover:()=>bindingClient.list(harness),enroll:async context=>{const b=(await bindingClient.list(harness)).find(b=>b.binding_id===context.native_proof.binding_id && sessionKey(b.identity)===sessionKey(context.native_proof.identity));if(!b)throw new Error('Connect from the native plugin first');return b;},deliver:async e=>{const b=await select(e);return b?await bindingClient.call(b,'plugin_deliver',e) as DeliveryOutcome:{state:'refused',reason:'Exact native session is not connected'};},reconcile:async e=>{const b=await select(e);return b?await bindingClient.call(b,'plugin_reconcile',e) as Observation[]:[];},observe:async function*(){/* Explicit lifecycle events publish observations; no polling factory. */},disconnect:async id=>{const b=(await bindingClient.list(harness)).find(b=>b.binding_id===id);if(b)throw new Error('Disconnect from the native plugin lifecycle');}};
}
export function pluginProofId():string{return randomUUID();}
