import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { invokeSourceTool,sourceToolJsonSchema } from '../source-tool.js';
import type { Context } from '@deepseek-ai/cordis';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot';
import { hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openStore } from '../../core/database.js';
import { issueEnrollment } from '../../core/bindings.js';
import { digest } from '../../protocol/canonical.js';
import type { Envelope } from '../../protocol/types.js';
import { pluginWireText,startPluginSession,type PluginHandle } from '../plugin-client.js';
import { enqueueOnOriginalAgent } from './native.js';
export interface DshPluginConfig {sessions:readonly {session_id:string;root:string;alias?:string}[]}
export async function installDsh(ctx:Context,config:DshPluginConfig,makeMessage:(envelope:Envelope,text:string)=>UserMessage):Promise<()=>Promise<void>>{
 const profile=ctx.get('profileContext') as ProfileContext|undefined;
 if(!profile || profile.startedBundles.some(name=>/sdk|headless/.test(name)) || !profile.startedBundles.some(name=>/web-app|desktop/.test(name)))throw new Error('Native Web/Desktop profile proof required; a new SDK is managed');
 const handles:PluginHandle[]=[],byAgent=new Map<unknown,PluginHandle>();
 const definition:ToolDefinition={name:'sessionbridge_request',description:'调用当前原生会话的会桥接口。先 context/sessions，角色设置 configure_roles；只接受业务参数，不接受来源身份。',parameters:sourceToolJsonSchema as ToolDefinition['parameters'],output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(raw,exec)=>{const handle=byAgent.get(exec.agent);if(!handle)throw new Error('This original native Agent is not connected');return invokeSourceTool(handle.connection_file,config.sessions.find(s=>s.session_id===handle.binding.identity.native_session_id)!.root,raw,()=>ctx.agents.get(handle.binding.identity.native_session_id as SessionId)===exec.agent);}};
 const disposeTool=ctx.tools?.register(definition);
 for(const selected of config.sessions){
  const sessionId=selected.session_id as SessionId,agent=ctx.agents.get(sessionId);if(!agent)continue;
  const root=realpathSync(selected.root);if(!agent.session.header.cwd || realpathSync(agent.session.header.cwd)!==root || !ctx.remoteAccess.allows({kind:'session',id:sessionId}))continue;
  const store=openStore(root),generation=randomUUID(),setup=issueEnrollment(store),identity={harness:'dsh',host_id:hostname(),profile_id:digest(realpathSync(profile.dir)),native_session_id:String(sessionId),project_id:store.project_id,runtime_generation:generation};store.close();
  const handle=await startPluginSession({setup,native_proof:{binding_id:randomUUID(),identity,challenge_id:randomUUID(),response:randomUUID(),expires_at:new Date(Date.now()+30000).toISOString()}},{root,alias:selected.alias??'dsh',validateCurrent:()=>ctx.agents.get(sessionId)===agent,deliver:async envelope=>enqueueOnOriginalAgent({ctx,agent,sessionId,generation,makeMessage},envelope)});handles.push(handle);byAgent.set(agent,handle);
  ctx.on('agent/disposed',async payload=>{if(payload.agent===agent){byAgent.delete(agent);await handle.close();}});
  ctx.on('session/event',(session,event)=>{
   if(session!==agent.session || event.type!=='user/message' || event.data.source.kind!=='sessionbridge')return;
   const messageId=event.data.source.message_id;
   const store=openStore(root);try{const row=store.db.prepare('SELECT envelope_json FROM deliveries WHERE message_id=?').get(messageId);if(row){const e=JSON.parse(String(row.envelope_json)) as Envelope;if(e.target.runtime_generation===generation && event.data.content.length===1 && event.data.content[0]?.type==='text' && event.data.content[0].text===pluginWireText(e))void handle.publish(e,'accepted').catch(()=>{});}}finally{store.close();}
  });
 }
 return async()=>{disposeTool?.();byAgent.clear();for(const handle of handles)await handle.close();};
}
