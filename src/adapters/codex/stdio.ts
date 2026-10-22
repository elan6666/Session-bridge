import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from '../../protocol/errors.js';
export const CODEX_WRITER_METHODS=new Set(['initialize','thread/read','thread/loaded/list','thread/queue/list','thread/queue/add','thread/turns/list']);
export interface CodexStdioOptions {binary:string;codexHome:string;cwd:string;trace?:(method:string)=>void}
export class CodexStdio {
 private child:ChildProcessWithoutNullStreams|null=null;private serial=0;private ready:Promise<unknown>|null=null;private closed=false;
 private pending=new Map<number,{method:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 constructor(private options:CodexStdioOptions){}
 private failAll(error:Error):void{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
 private initialize():Promise<unknown>{
  if(this.ready)return this.ready;
  if(this.closed)throw new BridgeError('writer_closed','Codex observer is closed','Create a new queue-only observer',3);
  const env:NodeJS.ProcessEnv={};for(const key of ['PATH','HOME','TMPDIR','LANG','USER','LOGNAME'])if(process.env[key])env[key]=process.env[key];env.CODEX_HOME=this.options.codexHome;
  this.child=spawn(this.options.binary,['-c','features.code_mode_host=false','-c','analytics.enabled=false','app-server','--listen','stdio://'],{env,cwd:this.options.cwd,stdio:'pipe'});
  let buffer=Buffer.alloc(0);
  this.child.stdout.on('data',(chunk:Buffer)=>{
   buffer=Buffer.concat([buffer,chunk]);
   if(buffer.length>16*1024*1024){this.failAll(new BridgeError('native_frame_too_large','Native response exceeds the observer frame limit','Use a narrower page; no response was truncated',3));this.child?.kill('SIGTERM');return;}
   let end:number;while((end=buffer.indexOf(10))>=0){const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);if(!line.length)continue;
    try{const message=JSON.parse(line.toString('utf8')) as {id?:number;method?:string;result?:unknown;error?:{code?:number}};
     // Tool requests and approvals belong to the original host. Never answer them.
     if(message.id===undefined || message.method)continue;
     const entry=this.pending.get(message.id);if(!entry)continue;this.pending.delete(message.id);clearTimeout(entry.timer);
     if(message.error)entry.reject(new BridgeError('native_rpc_refused','Native Codex RPC '+entry.method+' refused (code '+String(message.error.code??'unknown')+')','Inspect the exact host/version and native session; no alternate route was attempted',3));else entry.resolve(message.result);
    }catch{this.failAll(new BridgeError('native_frame_invalid','Invalid native JSON response','Reconnect the exact compatible native binary',3));}
   }
  });
  this.child.stderr.resume();this.child.once('error',()=>this.failAll(new BridgeError('writer_start_failed','Could not start the queue-only native observer','Check the desktop bundled executable and private profile',3)));
  this.child.once('exit',()=>this.failAll(new BridgeError('writer_exited','Native observer exited before replying','Reconcile any uncertain queue write before retrying',5)));
  this.child.stdin.on('error',()=>this.failAll(new BridgeError('writer_pipe_closed','Native observer input closed','Reconcile pending writes before retrying',5)));
  this.ready=this.rawRequest('initialize',{clientInfo:{name:'sessionbridge_queue_writer',version:'0.1.0'},capabilities:{experimentalApi:true}}).then(result=>{this.child!.stdin.write(JSON.stringify({method:'initialized'})+'\n');return result;});
  return this.ready;
 }
 private rawRequest(method:string,params:unknown):Promise<unknown>{
  const id=++this.serial,line=JSON.stringify({id,method,params})+'\n';
  if(Buffer.byteLength(line)>1024*1024)throw new BridgeError('native_request_too_large','Native request exceeds 1 MiB','Use artifact references rather than large messages');
  this.options.trace?.(method);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new BridgeError('native_timeout','Native observer RPC timed out','Reconcile the same message ID; do not blindly resend',5));},20_000);this.pending.set(id,{method,resolve,reject,timer});this.child!.stdin.write(line);});
 }
 async request(method:string,params:unknown):Promise<unknown>{
  if(!CODEX_WRITER_METHODS.has(method))throw new BridgeError('writer_method_forbidden','Writer method is forbidden by the queue-only allowlist','Use only metadata/history/queue reads or queue/add',3);
  const initialized=await this.initialize();if(method==='initialize')return initialized;
  return this.rawRequest(method,params);
 }
 async close():Promise<void>{
  if(this.closed)return;this.closed=true;const child=this.child;if(!child)return;
  child.stdin.end();
  const exited=()=>new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  if(child.exitCode===null && child.signalCode===null){await Promise.race([exited(),delay(2000)]);if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited(),delay(2000)]);}}
  this.failAll(new BridgeError('writer_closed','Observer closed','Reconcile pending writes if needed',5));
 }
}
