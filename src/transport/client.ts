import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { Actor } from '../protocol/types.js';
import { BridgeError } from '../protocol/errors.js';
import { encodeFrame, JsonLines } from './framing.js';
export class BridgeClient {
 constructor(private options:{socketPath:string;token:string;timeoutMs?:number}){}
 async call(actor:Actor,method:string,params:unknown):Promise<unknown>{
  const id=randomUUID(),request=encodeFrame({protocol_version:1,id,actor,method,params,capability:this.options.token});
  return new Promise((resolve,reject)=>{
   const socket=createConnection(this.options.socketPath),frames=new JsonLines();let settled=false;
   const finish=(error:unknown,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve(result);};
   const timer=setTimeout(()=>finish(new BridgeError('ipc_timeout','Local bridge response timed out','Check daemon status; reconcile any uncertain write before retrying',5)),this.options.timeoutMs??10_000);
   socket.once('connect',()=>socket.end(request));
   socket.on('error',()=>finish(new BridgeError('offline','Local bridge is not reachable','Run session-bridge daemon start for this project',3)));
   socket.on('data',chunk=>{try{for(const raw of frames.push(chunk)){const message=raw as {protocol_version:number;id:string;result?:unknown;error?:{code:string;message:string;recovery:string;exitCode:number}};if(message.protocol_version!==1 || message.id!==id)throw new BridgeError('invalid_response','Bridge response identity mismatch','Reconnect to the intended private daemon',3);if(message.error)finish(new BridgeError(message.error.code,message.error.message,message.error.recovery,message.error.exitCode));else finish(null,message.result);}}catch(error){finish(error);}});
   socket.once('end',()=>{if(!settled)finish(new BridgeError('incomplete_response','Bridge closed before a complete reply','Reconcile any uncertain write before retrying',5));});
  });
 }
}
