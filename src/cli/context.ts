import { lstat, readFile,realpath } from 'node:fs/promises';
import type { Actor, NativeContextProof, SessionIdentity } from '../protocol/types.js';
import { claudeSignal,codexSignal,nativeIndexPath,readSourcePointer,type NativeSignal } from '../core/connections.js';
import { digest,sessionKey } from '../protocol/canonical.js';
import { BridgeError } from '../protocol/errors.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readProject } from './init.js';
import { BridgeClient } from '../transport/client.js';
export interface ContextVerifier {verify(proof:NativeContextProof):Promise<SessionIdentity>}
export async function readNativeContext(env:Record<string,string|undefined>,proof:NativeContextProof,verifier:ContextVerifier):Promise<SessionIdentity>{
 if(!proof)throw new BridgeError('context_missing','Current native session is not connected','Run connect from the current native session',3);
 const identity=await verifier.verify(proof);
 if(sessionKey(identity)!==sessionKey(proof.identity) || (identity.harness==='codex' && env.CODEX_THREAD_ID && identity.native_session_id!==env.CODEX_THREAD_ID))throw new BridgeError('context_mismatch','Native context does not match the connected session','Reconnect this exact session after switching or /new',3);
 return identity;
}
export interface PrivateConnection {socketPath:string;token:string;actor:Actor;native?:NativeSignal;project_root?:string}
export async function loadConnection(env:Record<string,string|undefined>,root=env.SESSIONBRIDGE_PROJECT??process.cwd(),expectedHarness?:string):Promise<PrivateConnection>{
 let path=env.SESSIONBRIDGE_CONNECTION;
 let signal:NativeSignal|undefined;
 if(!path){
  if(env.CLAUDE_CODE_MESSAGING_SOCKET && (!expectedHarness || expectedHarness==='claude'))signal=claudeSignal(env.CLAUDE_CODE_MESSAGING_SOCKET);
  else if(env.CODEX_THREAD_ID && (!expectedHarness || expectedHarness==='codex'))signal=codexSignal(env.CODEX_THREAD_ID,env.CODEX_HOME);
  if(signal){const pointer=readSourcePointer(root,nativeIndexPath(root,signal));if(pointer)path=pointer.connection_file;}
  else if(env.SESSIONBRIDGE_CONTEXT_INDEX){const pointer=readSourcePointer(root,env.SESSIONBRIDGE_CONTEXT_INDEX);if(pointer){signal=pointer.native;path=pointer.connection_file;}}
 }
 if(!path)throw new BridgeError('context_missing','Current native session is not connected','Run session-bridge connect inside this session; no latest-session fallback is used',3);
 const info=await lstat(path);
 if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o077)!==0 || (process.getuid && info.uid!==process.getuid()))throw new BridgeError('unsafe_context','Connection file is not private','Reconnect using the native SessionBridge plugin',3);
 const data=JSON.parse(await readFile(path,'utf8')) as PrivateConnection;
 if(data.project_root && await realpath(data.project_root)!==await realpath(root))throw new BridgeError('context_project_mismatch','连接凭据属于另一个项目目录','显式选择已连接项目，不借用其他工作区身份',3);
 if(existsSync(join(root,'.session-bridge','project.json'))){const project=await readProject(root);if(data.actor?.scope.project_id!==project.project_id || data.actor?.session.project_id!==project.project_id || (data.project_root && await realpath(data.project_root)!==await realpath(root)))throw new BridgeError('context_project_mismatch','连接凭据不属于选择的项目或工作区','在当前项目重新连接；不会借用别的项目身份',3);}
 if(expectedHarness && data.actor?.session.harness!==expectedHarness)throw new BridgeError('context_mismatch','当前原生应用与连接记录不一致','从当前原生会话重新连接',3);
 if(signal && (!data.native || digest(signal)!==digest(data.native)))throw new BridgeError('context_mismatch','原生上下文信号已改变','重新连接当前会话；不会选择最近会话',3);
 if(data.native?.kind==='codex_thread' && (!env.CODEX_THREAD_ID || codexSignal(env.CODEX_THREAD_ID,env.CODEX_HOME).sha256!==data.native.sha256))throw new BridgeError('context_mismatch','Codex 原生 thread ID 不匹配','从目标原会话运行命令',3);
 if(data.native?.kind==='claude_socket' && (!env.CLAUDE_CODE_MESSAGING_SOCKET || digest(claudeSignal(env.CLAUDE_CODE_MESSAGING_SOCKET))!==digest(data.native)))throw new BridgeError('context_mismatch','Claude 原生 inbox 上下文不匹配','从当前已连接的原会话运行命令',3);
 if(typeof data.socketPath!=='string' || typeof data.token!=='string' || !data.actor)throw new BridgeError('invalid_context','Invalid private connection file','Reconnect this native session',3);
 return data;
}
export async function currentContext(env:Record<string,string|undefined>,root?:string):Promise<{identity:SessionIdentity;actor:Actor;request_id:string}>{
 const c=await loadConnection(env,root),client=new BridgeClient(c);
 const reply=await client.call(c.actor,'context',{}) as {actor:Actor;proof:NativeContextProof;request_id:string};
 const identity=await readNativeContext(env,reply.proof,{verify:async proof=>client.call(c.actor,'verify_context',{proof}) as Promise<SessionIdentity>});
 return {identity,actor:reply.actor,request_id:reply.request_id};
}
