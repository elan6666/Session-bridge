import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { Actor, Clock } from '../protocol/types.js';
import { systemClock } from '../protocol/types.js';
import { BridgeError } from '../protocol/errors.js';
import { digest } from '../protocol/canonical.js';
import { openStore } from '../core/database.js';
import { BindingService } from '../core/bindings.js';
import { listSessions } from '../cli/sessions.js';
import { authenticate, actorSchema, ContextAuth, createContextProof } from './auth.js';
import { encodeFrame, JsonLines, PARTIAL_FRAME_MS } from './framing.js';
export interface ServerHandle {address:string;close():Promise<void>}
export type RequestHandler=(actor:Actor,method:string,params:unknown)=>Promise<unknown>;
const requestSchema=z.strictObject({protocol_version:z.literal(1),id:z.string().min(1),capability:z.string(),actor:actorSchema,method:z.string().min(1),params:z.unknown()});
export function defaultSocketPath(projectRoot:string):string{return join(homedir(),'.local','share','sessionbridge','run',digest(projectRoot).slice(0,20)+'.sock');}
export async function startServer(options:{root:string;socketPath?:string;clock?:Clock;handle?:RequestHandler}):Promise<ServerHandle>{
 if(process.platform==='win32')throw new BridgeError('unsupported_platform','Windows transport has not been validated','Use a validated macOS or Linux environment',3);
 const clock=options.clock??systemClock,store=openStore(options.root),socketPath=options.socketPath??defaultSocketPath(store.root);
 try {
  if(Buffer.byteLength(socketPath)>100)throw new BridgeError('socket_path_too_long','Private socket path is too long','Choose a shorter private --socket path');
  const parent=dirname(socketPath);await mkdir(parent,{recursive:true,mode:0o700});const info=await lstat(parent);
  if(info.isSymbolicLink() || !info.isDirectory() || (process.getuid && info.uid!==process.getuid()) || (info.mode&0o077)!==0)throw new BridgeError('unsafe_socket_dir','Socket directory is not private','Use a directory you own with mode 0700',3);
  const sockets=new Set<Socket>();
  const server=createServer({allowHalfOpen:true},socket=>{
   sockets.add(socket);const frames=new JsonLines(clock);let timer:ReturnType<typeof setTimeout>|undefined,handled=false;
   const reply=(id:string,result?:unknown,error?:unknown)=>{
    if(socket.destroyed)return;
    try {
     const e=error instanceof BridgeError?error:new BridgeError('internal_error','Bridge request failed','Inspect private local service diagnostics',1);
     socket.end(encodeFrame(error?{protocol_version:1,id,error:{code:e.code,message:e.message,recovery:e.recovery,exitCode:e.exitCode}}:{protocol_version:1,id,result}));
    }catch{socket.destroy();}
   };
   socket.on('data',chunk=>{
    try {
     const messages=frames.push(chunk);
     if(messages.length>1 || (handled && messages.length))throw new BridgeError('one_request_only','One request is allowed per connection','Open a new connection for each operation');
     if(frames.partial && !timer)timer=setTimeout(()=>reply('',undefined,new BridgeError('frame_timeout','Partial frame deadline exceeded','Send a complete frame',3)),PARTIAL_FRAME_MS).unref();
     for(const raw of messages){
      handled=true;clearTimeout(timer);const req=requestSchema.parse(raw);
      void (async()=>{
       const actor=authenticate(store,req.capability,req.actor,req.method,req.params,clock);
       if(req.method==='context')return {actor,request_id:randomUUID(),proof:createContextProof(store,req.capability,actor,clock)};
       if(req.method==='verify_context')return new ContextAuth(store,clock).verify((req.params as {proof:Parameters<ContextAuth['verify']>[0]}).proof);
       if(req.method==='sessions')return {sessions:await listSessions(new BindingService(store,clock),{query:typeof req.params==='object' && req.params && 'query' in req.params?String(req.params.query):'',...(typeof req.params==='object' && req.params && 'harness' in req.params?{harness:String(req.params.harness)}:{}),...(typeof req.params==='object' && req.params && 'profile_id' in req.params?{profile_id:String(req.params.profile_id)}:{})})};
       if(options.handle)return options.handle(actor,req.method,req.params);
       throw new BridgeError('unsupported_operation','Operation is not available','Use a supported operation or update the bridge',3);
      })().then(result=>reply(req.id,result),error=>reply(req.id,undefined,error));
     }
    }catch(error){reply('',undefined,error instanceof BridgeError?error:new BridgeError('invalid_request','Invalid protocol 1 request','Use the installed bridge client'));}
   });
   socket.once('end',()=>{if(!handled){clearTimeout(timer);socket.end();}});
   socket.once('close',()=>{clearTimeout(timer);sockets.delete(socket);});socket.on('error',()=>socket.destroy());
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.off('error',reject);resolve();});});
  await chmod(socketPath,0o600);
  let closed=false;
  return {address:socketPath,close:async()=>{if(closed)return;closed=true;for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));try{await unlink(socketPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}finally{store.close();}}};
 }catch(error){store.close();if((error as NodeJS.ErrnoException).code==='EADDRINUSE')throw new BridgeError('daemon_exists','A daemon or stale socket already uses this path','Use the running daemon; verify its owner before removing a stale socket',3);throw error;}
}
