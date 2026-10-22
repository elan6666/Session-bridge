import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MockModel } from './mock-model.js';
import { initProject } from '../../src/cli/init.js';
import { openStore } from '../../src/core/database.js';
import { issueEnrollment } from '../../src/core/bindings.js';
import { createCodexAdapter,wireText } from '../../src/adapters/codex/adapter.js';
import { readCodexOwner } from '../../src/adapters/codex/version.js';
import { digest } from '../../src/protocol/canonical.js';
import type { Envelope,NativeContextProof,SessionIdentity } from '../../src/protocol/types.js';
export const BUNDLED_CODEX='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export const HAS_BUNDLED_CODEX=existsSync(BUNDLED_CODEX);
interface RpcMessage {id?:number;method?:string;params?:Record<string,unknown>;result?:unknown;error?:unknown}
export class NativeLabClient {
 private child:ChildProcessWithoutNullStreams;private serial=0;private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();private emitter=new EventEmitter();readonly events:RpcMessage[]=[];
 constructor(home:string,cwd:string){
  this.child=spawn(BUNDLED_CODEX,['app-server','--listen','stdio://'],{cwd,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,LANG:'en_US.UTF-8'},stdio:'pipe'});
  let text='';this.child.stdout.on('data',chunk=>{text+=chunk;let index;while((index=text.indexOf('\n'))>=0){const line=text.slice(0,index);text=text.slice(index+1);if(!line.trim())continue;const message=JSON.parse(line) as RpcMessage;if(message.id!==undefined && !message.method){const waiter=this.pending.get(message.id);if(waiter){this.pending.delete(message.id);clearTimeout(waiter.timer);if(message.error)waiter.reject(new Error(JSON.stringify(message.error)));else waiter.resolve(message.result);}}else {this.events.push(message);this.emitter.emit('event');}}});
  this.child.stderr.resume();this.child.on('error',error=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();});
 }
 get pid():number{return this.child.pid!;}
 async request(method:string,params:unknown):Promise<unknown>{const id=++this.serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Owned native lab RPC timeout: '+method));},15_000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
 async initialize():Promise<void>{await this.request('initialize',{clientInfo:{name:'sessionbridge_protocol_lab',version:'0.1'},capabilities:{experimentalApi:true}});this.child.stdin.write(JSON.stringify({method:'initialized'})+'\n');}
 wait(method:string,predicate:(params:Record<string,unknown>)=>boolean,timeoutMs=25_000):Promise<Record<string,unknown>>{
  const find=()=>this.events.find(e=>e.method===method && e.params && predicate(e.params))?.params;
  const existing=find();if(existing)return Promise.resolve(existing);
  return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{this.emitter.off('event',check);reject(new Error('Owned native lab event timeout: '+method));},timeoutMs);const check=()=>{const found=find();if(found){clearTimeout(timeout);this.emitter.off('event',check);resolve(found);}};this.emitter.on('event',check);});
 }
 async close():Promise<void>{this.child.stdin.end();if(this.child.exitCode===null){await Promise.race([new Promise<void>(resolve=>this.child.once('exit',()=>resolve())),delay(2000)]);if(this.child.exitCode===null){this.child.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>this.child.once('exit',()=>resolve())),delay(2000)]);}}}
}
export async function codexLab(t:{after:(fn:()=>Promise<void>)=>void}){
 const root=mkdtempSync('/tmp/sb-codex-'),home=join(root,'home'),workspace=join(root,'workspace');mkdirSync(home);mkdirSync(workspace);await initProject(workspace,{dryRun:false});
 const model=await new MockModel().start();
 writeFileSync(join(home,'config.toml'),`model = "probe-model"\nmodel_provider = "probe"\nmodel_context_window = 16000\n[features]\ncode_mode_host = false\nenable_request_compression = false\n[analytics]\nenabled = false\n[model_providers.probe]\nname = "Local protocol fixture"\nbase_url = ${JSON.stringify(model.baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
 const owner=new NativeLabClient(home,workspace),store=openStore(workspace);const allowed=new Map<string,SessionIdentity>();const trace:string[]=[];
 let ownerProof;try{await owner.initialize();ownerProof=await readCodexOwner(owner.pid);}catch(error){await owner.close();await model.close();store.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});throw error;}
 const adapter=createCodexAdapter({owner:ownerProof,desktopBinary:BUNDLED_CODEX,codexHome:home,expectedVersion:'0.163.0-alpha.11',projectRoot:workspace,trace:method=>trace.push(method),verifyContext:async proof=>{const known=allowed.get(proof.challenge_id);if(!known || digest(known)!==digest(proof.identity) || proof.response!=='owned-lab-proof')throw new Error('Invalid lab proof');return known;}});
 t.after(async()=>{await adapter.disconnect('');await owner.close();await model.close();store.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const threadResult=await owner.request('thread/start',{cwd:workspace,model:'probe-model',modelProvider:'probe',approvalPolicy:'never',sandbox:'read-only',ephemeral:false}) as {thread:{id:string}};
 const target:SessionIdentity={harness:'codex',host_id:'local',profile_id:'owned-lab',native_session_id:threadResult.thread.id,project_id:store.project_id,runtime_generation:'owner-'+owner.pid+'-'+randomUUID()};const proof:NativeContextProof={binding_id:randomUUID(),challenge_id:randomUUID(),identity:target,response:'owned-lab-proof',expires_at:new Date(Date.now()+60_000).toISOString()};allowed.set(proof.challenge_id,target);
 const envelope=(text:string):Envelope=>{const body={text,artifacts:[]};return {protocol_version:1,message_id:randomUUID(),task_id:randomUUID(),handoff_id:null,authority_epoch:0,sender:{...target,native_session_id:'external-source'},target,kind:'task',body,body_sha256:digest(body),created_at:new Date().toISOString(),expires_at:new Date(Date.now()+60_000).toISOString(),causation_id:null,correlation_id:'lab'};};
 async function turn(text:string,clientId?:string):Promise<string>{const result=await owner.request('turn/start',{threadId:target.native_session_id,input:[{type:'text',text,text_elements:[]}],...(clientId?{clientUserMessageId:clientId}:{})}) as {turn:{id:string}};return result.turn.id;}
 async function complete(id:string):Promise<Record<string,unknown>>{return owner.wait('turn/completed',p=>(p.turn as {id:string})?.id===id);}
 const warm=await turn('[PROBE_REPLY:WARM]');await complete(warm);await adapter.enroll({setup:issueEnrollment(store),native_proof:proof});
 async function waitHold(gate:string):Promise<void>{const deadline=Date.now()+5000;while(!model.requests.some(r=>r.state==='holding' && r.text.includes('[PROBE_HOLD:'+gate+']'))){if(Date.now()>deadline)throw new Error('Owned model did not hold');await delay(10);}}
 return {root,home,workspace,owner,model,adapter,target,trace,envelope,turn,complete,waitHold,wireText};
}
