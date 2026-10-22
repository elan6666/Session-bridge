import { randomUUID } from 'node:crypto';
import { existsSync,lstatSync,readFileSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join,relative,isAbsolute } from 'node:path';
import type { Actor,BindingRecord } from '../protocol/types.js';
import type { BridgeStore } from './database.js';
import { projectEndpoint } from './endpoint.js';
import { privateDirectory } from './private-paths.js';
import { issueSessionCapability } from '../transport/auth.js';
import { defaultSocketPath } from '../transport/server.js';
import { digest } from '../protocol/canonical.js';
export interface NativeSignal {harness:string;kind:'codex_thread'|'claude_socket'|'native_process';sha256:string}
export interface SourcePointer {binding_id:string;connection_file:string;native:NativeSignal}
export const SOURCE_OPERATIONS=['context','sessions','configure_roles','delegate_task','request_supervision','get_task_status','report_result','return_to_main','recover_delivery','cancel_pending','acknowledge_task'];
export function nativeIndexPath(root:string,signal:NativeSignal):string{if(!/^[a-z][a-z0-9_-]{0,63}$/.test(signal.harness))throw new Error('Invalid native harness name');return join(realpathSync(root),'.session-bridge','native-contexts',signal.harness,digest({kind:signal.kind,signal:signal.sha256})+'.json');}
export function claudeSignal(socket:string):NativeSignal{const info=lstatSync(socket);if(!info.isSocket() || info.isSymbolicLink())throw new Error('Native inbox is unavailable');return {harness:'claude',kind:'claude_socket',sha256:digest({path:realpathSync(socket),ino:info.ino,dev:info.dev})};}
export function codexSignal(threadId:string,profile=process.env.CODEX_HOME??join(homedir(),'.codex')):NativeSignal{return {harness:'codex',kind:'codex_thread',sha256:digest({thread_id:threadId,profile:realpathSync(profile)})};}
export function readSourcePointer(root:string,path:string):SourcePointer|null{
 try {const rel=relative(realpathSync(root),path),info=lstatSync(path);if(isAbsolute(rel) || !rel.startsWith('.session-bridge/native-contexts/') || realpathSync(path)!==path || !info.isFile() || info.isSymbolicLink() || (info.mode&0o077)!==0 || (process.getuid && info.uid!==process.getuid()))return null;const pointer=JSON.parse(readFileSync(path,'utf8')) as SourcePointer;const connectionRelative=relative(realpathSync(root),pointer.connection_file);if(!pointer.binding_id || !pointer.native || isAbsolute(connectionRelative) || !connectionRelative.startsWith('.session-bridge/contexts/'))return null;return pointer;}catch{return null;}
}
export function createSourceConnection(store:BridgeStore,binding:BindingRecord,signal:NativeSignal):{actor:Actor;connection_file:string;index_file:string;close():void}{
 if(signal.harness!==binding.identity.harness)throw new Error('Native source signal mismatch');const actor:Actor={binding_id:binding.binding_id,session:binding.identity,scope:{project_id:store.project_id,task_ids:['*'],operations:SOURCE_OPERATIONS}};
 privateDirectory(store.root,['.session-bridge','contexts']);privateDirectory(store.root,['.session-bridge','native-contexts',signal.harness]);
 const token=issueSessionCapability(store,actor),file=join(store.root,'.session-bridge','contexts',digest(binding.binding_id)+'.json'),index=nativeIndexPath(store.root,signal);
 writeFileSync(file,JSON.stringify({socketPath:projectEndpoint(store.root)?.address??defaultSocketPath(store.root),token,actor,native:signal,project_root:store.root}),{mode:0o600,flag:'wx'});
 const prior=readSourcePointer(store.root,index);if(prior && prior.binding_id!==binding.binding_id)store.db.prepare('UPDATE bindings SET active=0 WHERE binding_id=?').run(prior.binding_id);
 const temp=index+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify({binding_id:binding.binding_id,connection_file:file,native:signal}),{mode:0o600,flag:'wx'});renameSync(temp,index);
 return {actor,connection_file:file,index_file:index,close:()=>{if(readSourcePointer(store.root,index)?.binding_id===binding.binding_id)rmSync(index,{force:true});if(existsSync(file))rmSync(file,{force:true});}};
}
import { renameSync } from 'node:fs';
