import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { BindingRecord, DeliveryOutcome, Observation } from '../../protocol/types.js';
import type { BridgeStore } from '../../core/database.js';
import { BindingService } from '../../core/bindings.js';
import { BridgeError } from '../../protocol/errors.js';
import { encodeFrame, JsonLines } from '../../transport/framing.js';
export type HelperOperation='deliver'|'reconcile'|'disconnect';
export type HelperReply<T extends HelperOperation>=T extends 'deliver'?DeliveryOutcome:T extends 'reconcile'?Observation[]:void;
export interface RegisteredHelperClient {list():Promise<BindingRecord[]>;call<T extends HelperOperation>(bindingId:string,operation:T,payload:unknown):Promise<HelperReply<T>>}
export interface HelperReference {binding_id:string;socket:string;capability:string}
export function readPrivateReference(store:BridgeStore,binding:BindingRecord):HelperReference {
 const endpoint=JSON.parse(binding.endpoint_ref) as {kind:string;reference_file:string};
 const path=endpoint.reference_file,rel=relative(store.root,path);
 if(endpoint.kind!=='claude_child' || !rel.startsWith('.session-bridge/') || isAbsolute(rel) || realpathSync(path)!==path)throw new Error('Invalid helper reference');
 const info=lstatSync(path);
 if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o077)!==0 || (process.getuid && info.uid!==process.getuid()))throw new Error('Helper reference is not private');
 const ref=JSON.parse(readFileSync(path,'utf8')) as HelperReference;
 if(ref.binding_id!==binding.binding_id || typeof ref.capability!=='string' || typeof ref.socket!=='string')throw new Error('Helper reference identity mismatch');
 return ref;
}
export async function callHelper<T>(ref:HelperReference,operation:HelperOperation,payload:unknown):Promise<T>{
 const id=randomUUID(),request=encodeFrame({id,capability:ref.capability,operation,payload});
 return new Promise((resolve,reject)=>{
  const peer=createConnection(ref.socket),frames=new JsonLines();let done=false;
  const finish=(error:unknown,result?:T)=>{if(done)return;done=true;clearTimeout(timer);peer.destroy();if(error)reject(error);else resolve(result as T);};
  const timer=setTimeout(()=>finish(new BridgeError('helper_timeout','Native child helper did not reply','Reconcile the existing delivery; do not resend',5)),5000);
  peer.once('connect',()=>peer.end(request));peer.on('error',()=>finish(new BridgeError('helper_offline','Native child helper is unavailable','Reconnect from the original native session',3)));
  peer.on('data',chunk=>{try{for(const raw of frames.push(chunk)){const msg=raw as {id:string;result?:T;error?:string};if(msg.id!==id)throw new Error('Mismatched helper response');finish(msg.error?new Error(msg.error):null,msg.result);}}catch(error){finish(error);}});
  peer.once('end',()=>{if(!done)finish(new Error('Incomplete helper reply'));});
 });
}
export function createRegisteredHelperClient(store:BridgeStore):RegisteredHelperClient {
 const bindings=new BindingService(store);
 return {list:()=>bindings.resolve({query:'',harness:'claude'}),call:async<T extends HelperOperation>(id:string,operation:T,payload:unknown):Promise<HelperReply<T>>=>{
  const binding=bindings.get(id);if(!binding || !bindings.isUsable(id) || binding.identity.harness!=='claude')throw new Error('Native binding is unavailable');
  return callHelper<HelperReply<T>>(readPrivateReference(store,binding),operation,payload);
 }};
}
