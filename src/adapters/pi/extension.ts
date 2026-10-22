import type { TSchema } from 'typebox';
import { invokeSourceTool,sourceToolJsonSchema } from '../source-tool.js';
import type { PluginHandle } from '../plugin-client.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { hostname } from 'node:os';
import { existsSync,realpathSync } from 'node:fs';
import { installPi } from './lifecycle.js';
import { startPluginSession } from '../plugin-client.js';
import { digest } from '../../protocol/canonical.js';
import { openStore } from '../../core/database.js';
import { issueEnrollment } from '../../core/bindings.js';
import { randomUUID } from 'node:crypto';
export default function(pi:ExtensionAPI):void {
 let active:PluginHandle|undefined;
 pi.registerTool({name:'sessionbridge_request',label:'会桥',description:'当前原生会话的会桥接口。先 context，再 sessions；只设置角色用 configure_roles，具体任务才用 request。不得从参数填写来源身份。',parameters:sourceToolJsonSchema as TSchema,execute:async(_id,params,_signal,_update,ctx)=>{const handle=active;if(!handle)throw new Error('Current Pi session is not connected');const result=await invokeSourceTool(handle.connection_file,ctx.cwd,params,()=>active===handle && ctx.sessionManager.getSessionId()===handle.binding.identity.native_session_id);return {content:[{type:'text',text:JSON.stringify(result)}],details:{}};}});
 installPi(pi,{start:async(ctx,generation,deliver)=>{
  const root=realpathSync(ctx.cwd);if(!existsSync(root+'/.session-bridge/project.json'))return;const store=openStore(root),session=ctx.sessionManager.getSessionId();
  const identity={harness:'pi',host_id:hostname(),profile_id:digest(realpathSync(ctx.sessionManager.getSessionDir())),native_session_id:session,project_id:store.project_id,runtime_generation:generation};
  const setup=issueEnrollment(store);store.close();
  const previousConnection=process.env.SESSIONBRIDGE_CONNECTION,previousProject=process.env.SESSIONBRIDGE_PROJECT;const handle=await startPluginSession({setup,native_proof:{binding_id:randomUUID(),identity,challenge_id:randomUUID(),response:randomUUID(),expires_at:new Date(Date.now()+30000).toISOString()}},{root,alias:'pi',validateCurrent:()=>ctx.sessionManager.getSessionId()===session,deliver});
  active=handle;process.env.SESSIONBRIDGE_CONNECTION=handle.connection_file;process.env.SESSIONBRIDGE_PROJECT=root;return {close:async()=>{if(active===handle)active=undefined;await handle.close();if(process.env.SESSIONBRIDGE_CONNECTION===handle.connection_file){if(previousConnection===undefined)delete process.env.SESSIONBRIDGE_CONNECTION;else process.env.SESSIONBRIDGE_CONNECTION=previousConnection;if(previousProject===undefined)delete process.env.SESSIONBRIDGE_PROJECT;else process.env.SESSIONBRIDGE_PROJECT=previousProject;}},publish:handle.publish};
 }});
}
