import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Actor } from '../protocol/types.js';
import type { BridgeClient } from '../transport/client.js';
import { BridgeError } from '../protocol/errors.js';
import { sessionKey } from '../protocol/canonical.js';
import { requestForRoleTool,roleToolSchema } from '../cli/request.js';
const text=z.string().min(1),id={request_id:text,original_text:z.string().optional(),dry_run:z.boolean().optional()},target={target_query:text,target_harness:text.optional(),target_profile:text.optional()};
const selector=(p:Record<string,unknown>)=>({query:p.target_query,...(p.target_harness?{harness:p.target_harness}:{}),...(p.target_profile?{profile_id:p.target_profile}:{})});
export function createMcpServer(options:{client:BridgeClient;getActor:()=>Actor|Promise<Actor>}):McpServer {
 const server=new McpServer({name:'sessionbridge',version:'0.1.0'});
 const register=(name:string,description:string,schema:z.ZodType,route:(p:Record<string,unknown>)=>{method:string;params:unknown})=>server.registerTool(name,{description,inputSchema:schema},async input=>{
  try{
   const actor=await options.getActor();
   const current=await options.client.call(actor,'context',{}) as {actor:Actor};
   if(sessionKey(current.actor.session)!==sessionKey(actor.session) || current.actor.binding_id!==actor.binding_id)throw new BridgeError('source_changed','Current native session generation changed','Reconnect the current original session',3);
   const p=schema.parse(input) as Record<string,unknown>,call=route(p),result=await options.client.call(actor,call.method,call.params);
   return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
  }catch(error){const e=error instanceof BridgeError?error:new BridgeError('mcp_request_failed','请求未完成或来源未核实','在原生会话连接会桥后重试；不依据文本中的会话 ID 授权',3);return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:{code:e.code,message:e.message,recovery:e.recovery}})}]};}
 });
 register('list_sessions','查看本项目显式连接的会话，重名时保留全部候选。',z.strictObject({query:z.string().optional(),harness:text.optional(),profile_id:text.optional()}),p=>({method:'sessions',params:p}));
 register('configure_roles','只把当前原生会话设为主会话并指定监督者，不派任务或开监控。',roleToolSchema,p=>({method:'request',params:requestForRoleTool(p)}));
 register('delegate_task','向准确的已连接会话派发有路径范围、验收和截止时间的任务。',z.strictObject({...id,...target,goal:text,acceptance:z.array(text).min(1),read_paths:z.array(text),write_paths:z.array(text),deadline_at:z.iso.datetime()}),p=>{const {target_query:_q,target_harness:_h,target_profile:_p,...rest}=p;return {method:'request',params:{...rest,operation:'delegate',target:selector(p)}};});
 register('get_task_status','不传参数时查看当前会话可见的任务列表和角色；已知准确 task_id 时查看其投递、执行、核验和续接。',z.strictObject({task_id:text.optional(),for_request:text.optional()}),p=>({method:'get_task_status',params:p}));
 register('acknowledge_task','原主会话接收、核验结果、设置下一步或提交真实续接回执；空确认不算续接。',z.strictObject({task_id:text,action:z.enum(['receive','verify','continue','plan_next']).default('receive'),evidence_file:text.optional(),next_action_id:text.optional(),next_instruction:text.optional(),next_argv:z.array(z.string()).optional(),next_artifact_paths:z.array(text).optional()}),p=>({method:'acknowledge_task',params:p}));
 register('report_result','执行会话报告实际产物，结果先标待主会话验收。',z.strictObject({task_id:text,summary:text,artifact_paths:z.array(text),native_receipts:z.array(text).optional(),attempt:z.number().int().positive().optional(),authority_epoch:z.number().int().nonnegative().optional()}),p=>({method:'report_result',params:p}));
 register('request_supervision','明确运行收据、监督者、周期和截止时间后设置监督；停止不会杀作业。',z.strictObject({...id,task_id:text,run_file:text,supervisor_query:text,supervisor_harness:text.optional(),interval_seconds:z.number().int().min(1).max(86400),deadline_at:z.iso.datetime(),repair_paths:z.array(text)}),p=>({method:'request_supervision',params:p}));
 register('return_to_main','执行者先准备权限交接，再将结果回报原主会话。',z.strictObject({...id,task_id:text}),p=>({method:'request',params:{...p,operation:'return'}}));
 register('recover_delivery','只核对既有消息的队列与原生日志，不盲目重发。',z.strictObject({...id,message_id:text}),p=>({method:'request',params:{...p,operation:'recover'}}));
 register('cancel_pending','停止该任务未来的派发，可同时撤销监督；已运行作业继续。',z.strictObject({...id,task_id:text,stop_supervision:z.boolean().optional()}),p=>({method:'request',params:{...p,operation:'cancel_pending'}}));
 return server;
}
export function readRequestId():string{return randomUUID();}
