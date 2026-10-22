import { z } from 'zod';
import { loadConnection } from '../cli/context.js';
import { BridgeClient } from '../transport/client.js';
import { requestForRoleTool } from '../cli/request.js';
export const sourceToolSchema=z.strictObject({method:z.enum(['context','sessions','configure_roles','delegate_task','return_to_main','recover_delivery','cancel_pending','request','get_task_status','report_result','acknowledge_task','request_supervision']),params:z.record(z.string(),z.unknown()).default({}).describe('context/sessions: {} or sessions {query}. configure_roles: {request_id,supervisor_query}; no main/operation/supervisor fields. request: full Skill request with operation=assign_roles|delegate|supervise|status|return|recover|cancel_pending. report_result: {task_id,summary,artifact_paths}. Never supply actor/source identity.')});
export const sourceToolJsonSchema=z.toJSONSchema(sourceToolSchema);
export async function invokeSourceTool(file:string,root:string,raw:unknown,validate:()=>boolean){
 if(!validate())throw new Error('Original native caller is no longer current');
 const p=sourceToolSchema.parse(raw),c=await loadConnection({SESSIONBRIDGE_CONNECTION:file,SESSIONBRIDGE_PROJECT:root},root),client=new BridgeClient(c);await client.call(c.actor,'context',{});
 if(!validate())throw new Error('Native source changed during the call');
 if(p.method==='configure_roles')return client.call(c.actor,'request',requestForRoleTool(p.params));
 if(['return_to_main','recover_delivery','cancel_pending'].includes(p.method)){const operation=({return_to_main:'return',recover_delivery:'recover',cancel_pending:'cancel_pending'} as Record<string,string>)[p.method]!;return client.call(c.actor,'request',{...p.params,operation});}
 if(p.method==='delegate_task'){const {target_query,target_harness,target_profile,...rest}=p.params;return client.call(c.actor,'request',{...rest,operation:'delegate',target:{query:target_query,...(target_harness?{harness:target_harness}:{}),...(target_profile?{profile_id:target_profile}:{})}});}
 return client.call(c.actor,p.method,p.params);
}
