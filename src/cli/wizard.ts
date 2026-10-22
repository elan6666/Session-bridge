import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Actor,BindingRecord } from '../protocol/types.js';
import { sessionKey } from '../protocol/canonical.js';
import { BridgeError } from '../protocol/errors.js';
import { BindingService } from '../core/bindings.js';
import { exactBinding,requireActor } from '../core/tasks.js';
import type { BridgeStore } from '../core/database.js';
export interface WizardIO {select(prompt:string,choices:string[]):Promise<number>}
export function bindingLabel(b:BindingRecord):string{return `${b.alias} · ${b.identity.harness} · ${b.identity.profile_id} · …${b.identity.native_session_id.slice(-6)} · ${b.mode}`;}
export async function writeRoleSessionMap(store:BridgeStore,actor:Actor,io:WizardIO):Promise<string>{
 requireActor(store,actor,'configure_roles');const main=await exactBinding(store,actor.session);
 const candidates=(await new BindingService(store).resolve({query:''})).filter(b=>sessionKey(b.identity)!==sessionKey(actor.session));
 if(!candidates.length)throw new BridgeError('supervisor_missing','尚无可选择的已连接监督会话','在目标原会话启用连接器，再回来选择',3);
 const choice=await io.select('选择监督会话（只设置角色，不派任务或开监控）',candidates.map(bindingLabel));
 const supervisor=candidates[choice];if(!supervisor)throw new BridgeError('invalid_selection','选择无效','从列出的编号重新选择',4);
 const path=join(store.root,'.session-bridge','session-map.json');
 await writeFile(path,JSON.stringify({protocol_version:1,purpose:'role_setup',project_id:store.project_id,main:{binding_id:main.binding_id,identity:main.identity},supervisor:{binding_id:supervisor.binding_id,identity:supervisor.identity}},null,2)+'\n',{mode:0o600,flag:'wx'});
 return path;
}

export async function interactiveWizard(root:string):Promise<number>{
 const {createInterface}=await import('node:readline/promises'),{loadConnection,currentContext}=await import('./context.js'),{BridgeClient}=await import('../transport/client.js');
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{
  process.stdout.write('会桥中文向导：只设置主/监督角色，实际任务随后由你提出。\n');
  const context=await currentContext(process.env,root),connection=await loadConnection(process.env,root);process.stdout.write(`当前主会话：${context.identity.harness} …${context.identity.native_session_id.slice(-6)}\n`);
  const store=(await import('../core/database.js')).openStore(root);let candidates:BindingRecord[];try{candidates=(await new BindingService(store).resolve({query:''})).filter(b=>sessionKey(b.identity)!==sessionKey(context.identity));}finally{store.close();}
  if(!candidates.length)throw new BridgeError('supervisor_missing','尚无连接的监督会话','先在目标原会话启用连接器并 connect',3);
  candidates.forEach((b,i)=>process.stdout.write(`${i+1}. ${bindingLabel(b)}\n`));const answer=await rl.question('选择监督者编号（回车取消）：');if(!answer.trim())return 0;const b=candidates[Number(answer)-1];if(!b)throw new BridgeError('invalid_selection','无效编号','重新运行向导',4);
  const result=await new BridgeClient(connection).call(connection.actor,'request',{request_id:context.request_id,operation:'assign_roles',main:'current',supervisor:{query:b.binding_id,harness:b.identity.harness,profile_id:b.identity.profile_id}});process.stdout.write(JSON.stringify(result)+'\n');return 0;
 }finally{rl.close();}
}
