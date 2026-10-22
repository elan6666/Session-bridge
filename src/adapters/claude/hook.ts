import { spawn,execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync,realpathSync,writeFileSync } from 'node:fs';
import { privateDirectory } from '../../core/private-paths.js';
import { openStore,transaction } from '../../core/database.js';
import { BindingService,issueEnrollment } from '../../core/bindings.js';
import { digest } from '../../protocol/canonical.js';
import type { NativeProcessOwner } from '../../protocol/types.js';
import { createSourceConnection,claudeSignal,nativeIndexPath,readSourcePointer } from '../../core/connections.js';
import { readCodexOwner } from '../codex/version.js';
import { startClaudeChild } from './child-helper.js';
import { setTimeout as delay } from 'node:timers/promises';
import { assertClaudeStartup,endClaudeStartup,reserveClaudeStartup,withClaudeStartup } from './startup.js';
function diagnostic(input:NativeHookInput,state:string,reason:string){try{const root=realpathSync(input.cwd),dir=privateDirectory(root,['.session-bridge','native-diagnostics']);writeFileSync(join(dir,'claude-'+digest(input.session_id)+'.json'),JSON.stringify({state,reason,session_id_sha256:digest(input.session_id),at:new Date().toISOString()}),{mode:0o600});}catch{/* Diagnostics never change native execution. */}}
interface NativeHookInput {session_id:string;transcript_path:string;cwd:string;hook_event_name:string;owner?:NativeProcessOwner;startup_token?:string}
async function nativeOwner():Promise<NativeProcessOwner>{let pid=process.ppid;for(let i=0;i<12 && pid>1;i++){const owner=await readCodexOwner(pid);if(/(?:claude|claude\.exe)$/.test(owner.executable))return owner;pid=Number(execFileSync('ps',['-p',String(pid),'-o','ppid='],{encoding:'utf8',timeout:3000}).trim());}throw new Error('Original Claude owner is unavailable');}
async function child(input:NativeHookInput):Promise<void>{
 const root=realpathSync(input.cwd),store=openStore(root),socket=process.env.CLAUDE_CODE_MESSAGING_SOCKET;
 if(!socket || !input.owner || !input.startup_token){store.close();throw new Error('Native inbox, owner or startup unavailable');}
 const token=input.startup_token;
 try{
 const original=await readCodexOwner(input.owner.pid);if(digest(original)!==digest(input.owner))throw new Error('Native owner changed');
 const version=execFileSync(original.executable,['--version'],{encoding:'utf8',timeout:5000}).trim().split(' ')[0]!;if(version!=='2.1.306')throw new Error('Claude version requires revalidation');
 const profile=realpathSync(process.env.CLAUDE_CONFIG_DIR??join(process.env.HOME!,'.claude')),signal=claudeSignal(socket),generation=digest({signal,session_id:input.session_id,owner:original});
 const identity={harness:'claude',host_id:hostname(),profile_id:digest(profile),native_session_id:input.session_id,project_id:store.project_id,runtime_generation:generation};
 assertClaudeStartup(store,signal,token);
 const current=()=>{try{assertClaudeStartup(store,signal,token);return readSourcePointer(root,nativeIndexPath(root,signal))?.binding_id===proof.binding_id;}catch{return false;}};
 const setup=issueEnrollment(store),proof={binding_id:randomUUID(),challenge_id:randomUUID(),response:randomUUID(),identity,expires_at:new Date(Date.now()+86400000).toISOString()};
 const handle=await startClaudeChild({setup,native_proof:proof},{root,host:{session_id:input.session_id,profile_id:identity.profile_id,runtime_generation:generation,transcript_path:input.transcript_path,cwd:root,version,owner:original},validateCurrent:current});
 let source:ReturnType<typeof createSourceConnection>;
 try{await new BindingService(store).enroll(setup,handle.binding,()=>assertClaudeStartup(store,signal,token));source=withClaudeStartup(store,signal,token,()=>createSourceConnection(store,handle.binding,signal));}catch(error){await handle.close();throw error;}
 const reference=JSON.parse(handle.binding.endpoint_ref) as {reference_file:string};writeFileSync(reference.reference_file+'.ready',JSON.stringify({binding_id:handle.binding.binding_id,session_id:input.session_id,connection_file:source.connection_file}),{mode:0o600});
 let closing=false;const close=async()=>{if(closing)return;closing=true;clearInterval(watch);source.close();await handle.close();store.close();process.exitCode=0;};
 const watch=setInterval(()=>{try{if(!current() || digest(claudeSignal(socket))!==digest(signal))void close();}catch{void close();}},1000);watch.unref();
 process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
 }catch(error){store.close();throw error;}
}
export async function claudeSessionStart(input:NativeHookInput):Promise<void>{
 if(!['SessionStart','SessionEnd','UserPromptSubmit'].includes(input.hook_event_name) || !input.session_id)return;
 if(!process.env.CLAUDE_CODE_MESSAGING_SOCKET){diagnostic(input,'blocked','native_messaging_socket_unavailable');return;}
 try{readFileSync(join(input.cwd,'.session-bridge','project.json'));}catch{return;}
 const signal=claudeSignal(process.env.CLAUDE_CODE_MESSAGING_SOCKET),store=openStore(input.cwd);let reservation:{token:string;start:boolean}|undefined;
 try{
  const prior=readSourcePointer(store.root,nativeIndexPath(store.root,signal)),service=new BindingService(store),binding=prior?service.get(prior.binding_id):null;
  if(input.hook_event_name==='SessionEnd'){endClaudeStartup(store,signal,input.session_id);if(binding?.identity.native_session_id===input.session_id)store.db.prepare('UPDATE bindings SET active=0 WHERE binding_id=?').run(binding.binding_id);return;}
  if(input.hook_event_name==='UserPromptSubmit' && binding && service.isUsable(binding.binding_id) && binding.identity.native_session_id!==input.session_id){diagnostic(input,'blocked','native_prompt_session_changed');return;}
  if(binding?.identity.native_session_id===input.session_id && service.isUsable(binding.binding_id))return;
  reservation=reserveClaudeStartup(store,signal,input.session_id,input.hook_event_name as 'SessionStart'|'UserPromptSubmit');
  if(reservation.start && binding)transaction(store,()=>{assertClaudeStartup(store,signal,reservation!.token);store.db.prepare('UPDATE bindings SET active=0 WHERE binding_id=?').run(binding.binding_id);});
 }finally{store.close();}
 if(!input.transcript_path || !process.env.CLAUDE_CODE_MESSAGING_TOKEN || !reservation)return;
 if(reservation.start){diagnostic(input,'starting','native_inbox_available');const owner=await nativeOwner(),checkStore=openStore(input.cwd);try{assertClaudeStartup(checkStore,signal,reservation.token);}finally{checkStore.close();}const processChild=spawn(process.execPath,[fileURLToPath(import.meta.url),'--child'],{cwd:input.cwd,env:process.env,stdio:['pipe','ignore','ignore'],detached:true});processChild.stdin!.end(JSON.stringify({...input,owner,startup_token:reservation.token}));processChild.unref();}
 // A warm conversation already has a transcript. Wait for its private child so
 // the first model tool after native /reload-plugins sees the new connection.
 // SessionStart stays nonblocking because the native first transcript write can
 // happen only after that hook returns.
 if(input.hook_event_name==='UserPromptSubmit'){
  const readyStore=openStore(input.cwd);try{const end=Date.now()+5000;while(Date.now()<end){const pointer=readSourcePointer(readyStore.root,nativeIndexPath(readyStore.root,signal)),binding=pointer?new BindingService(readyStore).get(pointer.binding_id):null;if(binding?.identity.native_session_id===input.session_id && new BindingService(readyStore).isUsable(binding.binding_id))return;await delay(50);}diagnostic(input,'blocked','native_child_not_ready');}finally{readyStore.close();}
 }
}
if(process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){let parsedInput:NativeHookInput|undefined;try{const raw=readFileSync(0,'utf8');if(Buffer.byteLength(raw)>65536)throw new Error('Oversized hook context');const input=JSON.parse(raw) as NativeHookInput;parsedInput=input;if(process.argv.includes('--child'))await child(input);else await claudeSessionStart(input);}catch(error){try{if(parsedInput)diagnostic(parsedInput,'failed',error instanceof Error?error.message.slice(0,200):'native_child_failed');}catch{/* stdin already consumed */}process.stderr.write('SessionBridge: native child enrollment unavailable; run doctor before delegating.\n');process.exitCode=1;}}
