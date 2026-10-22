import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync,writeFileSync } from 'node:fs';
import { homedir,hostname } from 'node:os';
import { join,relative,isAbsolute } from 'node:path';
import { z } from 'zod';
import { openStore } from '../../core/database.js';
import { BindingService,issueEnrollment } from '../../core/bindings.js';
import { createSourceConnection,codexSignal } from '../../core/connections.js';
import { privateDirectory } from '../../core/private-paths.js';
import { digest } from '../../protocol/canonical.js';
import { BridgeError } from '../../protocol/errors.js';
import { readCodexOwner,validateCodexBinary } from './version.js';
import { createCodexAdapter } from './adapter.js';
const exec=promisify(execFile);
export const DESKTOP_CODEX='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export const CODEX_VERSION='0.163.0-alpha.11';
export const codexConfigSchema=z.strictObject({desktopBinary:z.string(),codexHome:z.string(),expectedVersion:z.literal(CODEX_VERSION),projectRoot:z.string(),nativeCwd:z.string(),owner:z.strictObject({pid:z.number().int().positive(),started_at:z.string(),executable:z.string()})});
export async function originalCodexOwner(binary=DESKTOP_CODEX){
 let pid=process.ppid;const exact=realpathSync(binary);
 for(let i=0;i<12 && pid>1;i++){
  // Wrappers can expose a relative process title (e.g. "node"). It is
  // neither an executable path nor proof that the original Codex is offline.
  const command=await exec('ps',['-p',String(pid),'-o','comm='],{timeout:3000,maxBuffer:4096}),executable=command.stdout.trim();
  if(isAbsolute(executable) && realpathSync(executable)===exact)return readCodexOwner(pid);
  const parent=await exec('ps',['-p',String(pid),'-o','ppid='],{timeout:3000,maxBuffer:1024});pid=Number(parent.stdout.trim());
 }
 throw new BridgeError('native_source_required','连接必须从 Codex 原会话的执行工具发起','在要连接的会话里运行 connect；外部终端不能填写聊天 ID 冒充来源',3);
}
export async function connectCodex(root:string,alias:string){
 const thread=process.env.CODEX_THREAD_ID;if(!thread)throw new BridgeError('native_source_required','当前进程没有原生聊天身份','请在 Codex 会话中运行 connect',3);
 const projectRoot=realpathSync(root),nativeCwd=realpathSync(process.cwd()),rel=relative(nativeCwd,projectRoot);
 if(isAbsolute(rel) || rel==='..' || rel.startsWith('../'))throw new BridgeError('native_project_mismatch','选定项目不在原会话目录范围内','显式选择本会话下的工作目录',3);
 const desktopBinary=DESKTOP_CODEX,codexHome=realpathSync(process.env.CODEX_HOME??join(homedir(),'.codex')),owner=await originalCodexOwner(desktopBinary),version=await validateCodexBinary(desktopBinary,CODEX_VERSION),store=openStore(projectRoot);
 try{
  const identity={harness:'codex',host_id:hostname(),profile_id:digest(codexHome),native_session_id:thread,project_id:store.project_id,runtime_generation:digest({owner,version:version.sha256,thread,profile:codexHome})};
  const prior=(await new BindingService(store).resolve({query:'',harness:'codex',profile_id:identity.profile_id})).find(b=>b.identity.native_session_id===thread && b.identity.runtime_generation===identity.runtime_generation);
  if(prior)return {state:'connected',binding_id:prior.binding_id,alias:prior.alias,identity:prior.identity,reused:true};
  const setup=issueEnrollment(store),proof={binding_id:randomUUID(),challenge_id:randomUUID(),response:randomUUID(),identity,expires_at:new Date(Date.now()+30000).toISOString()};
  const config={desktopBinary,codexHome,expectedVersion:CODEX_VERSION,projectRoot,nativeCwd,owner} as const;
  // This bootstrap proof is minted inside the proven native descendant, never from request text.
  const adapter=createCodexAdapter({...config,verifyContext:async p=>{if(digest(p)!==digest(proof))throw new Error('Native bootstrap challenge mismatch');return identity;}});
  const binding=await adapter.enroll({setup,native_proof:proof});binding.alias=alias;
  await new BindingService(store).enroll(setup,binding);
  const dir=privateDirectory(projectRoot,['.session-bridge','connectors','codex']);writeFileSync(join(dir,digest(binding.binding_id)+'.json'),JSON.stringify(config),{flag:'wx',mode:0o600});
  createSourceConnection(store,binding,codexSignal(thread,codexHome));
  return {state:'connected',binding_id:binding.binding_id,alias,identity,mapping:{native_cwd:nativeCwd,scoped_project:projectRoot}};
 }finally{store.close();}
}
