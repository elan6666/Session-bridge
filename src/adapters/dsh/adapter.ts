import { digest,sessionKey } from '../../protocol/canonical.js';
import type { Adapter } from '../contract.js';
import type { BindingRecord,DeliveryOutcome,Envelope,NativeProcessOwner,Observation,SessionIdentity } from '../../protocol/types.js';
export interface HostProof {host_id:string;native_host_id:string;version:string;mode:'attached'|'managed';owner:NativeProcessOwner;permissions:string[];bindings:BindingRecord[]}
export interface DshHostClient {identify():Promise<HostProof>;enqueue(session:SessionIdentity,message:Envelope):Promise<DeliveryOutcome>;follow(session:SessionIdentity,signal:AbortSignal):AsyncIterable<Observation>}
export function createDshAdapter({hostClient}:{hostClient:DshHostClient}):Adapter {
 let pin:string|undefined;
 const proof=async(permission:string,session?:SessionIdentity)=>{
  const p=await hostClient.identify();
  if(p.mode!=='attached' || p.version!=='0.2.1-rc.2' || !p.native_host_id || !p.owner.pid || !p.owner.started_at || !p.permissions.includes(permission))return null;
  const fingerprint=digest({native_host_id:p.native_host_id,owner:p.owner,version:p.version});
  if(pin && pin!==fingerprint)return null;pin=fingerprint;
  if(session && (!p.bindings.some(b=>b.active && Date.parse(b.expires_at)>Date.now() && sessionKey(b.identity)===sessionKey(session)) || session.host_id!==p.host_id))return null;
  return p;
 };
 return {probe:async()=>{const p=await proof('enqueue');return {harness:'dsh',version:p?.version??null,modes:{attached:{supported:Boolean(p),evidence:p?.native_host_id??null,constraints:['Original native Host and exact live session required','No cold resume or SDK replacement']}},capabilities:[]};},discover:async()=>(await proof('observe'))?.bindings??[],enroll:async context=>{const p=await proof('observe',context.native_proof.identity),b=p?.bindings.find(b=>b.binding_id===context.native_proof.binding_id);if(!b)throw new Error('Exact native dsh Host is not connected');return b;},deliver:async e=>{if(!await proof('enqueue',e.target))return {state:'refused',reason:'Original native Host, permission or exact session is unavailable'};return hostClient.enqueue(e.target,e);},reconcile:async e=>{if(!await proof('observe',e.target))return [];const result:Observation[]=[],signal=AbortSignal.timeout(500);try{for await(const observation of hostClient.follow(e.target,signal)){if(observation.message_id===e.message_id && sessionKey(observation.session)===sessionKey(e.target)){result.push(observation);break;}}}catch{ /* A bounded observation can remain unknown. */ }return result;},observe:async function*(binding,signal){if(!await proof('observe',binding.identity))return;yield* hostClient.follow(binding.identity,signal);},disconnect:async()=>{/* Native lifecycle owns teardown; never dispose an Agent. */}};
}
