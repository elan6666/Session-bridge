import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { reserveEndpoint } from '../core/endpoint.js';
import { reclaimStaleCoreSocket } from '../core/stale-socket.js';
import { openStore } from '../core/database.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { startServer,defaultSocketPath,type ServerHandle } from '../transport/server.js';
import { RequestService,parseRequest } from './request.js';
import { BridgeError } from '../protocol/errors.js';
import { createRuntimeRegistry,runtimeWorkflow } from '../core/runtime.js';
import { ReturnService,type ActionEvidence,type ContinuationEvidence } from '../return/service.js';
import { readTask,TaskService } from '../core/tasks.js';
import { artifactRefs,scopedFile } from '../core/scoped-files.js';
import { digest } from '../protocol/canonical.js';
import { SupervisionService } from '../supervision/leases.js';
import { verifyRecordedAction } from '../return/native-action.js';
import { supervisionWaker } from '../supervision/waker.js';
export async function runDaemon(root:string,socketPath?:string,suppliedRegistry?:AdapterRegistry):Promise<ServerHandle>{
 const store=openStore(root),registry=suppliedRegistry??createRuntimeRegistry(store),workflow=runtimeWorkflow(store),returns=new ReturnService({store,registry,...workflow,verifyNativeAction:(actor,evidence,purpose)=>verifyRecordedAction(store,actor,evidence,purpose)});
 const supervision=new SupervisionService({store,wake:supervisionWaker(store,registry,workflow.workflow)});
 const requests=new RequestService({store,registry,...workflow,returns,handlers:{supervise:async(actor,r,supervisor)=>supervision.armSupervision(actor,{task_id:r.task_id,run:r.run,supervisor:supervisor.identity,return_to:readTask(store,r.task_id).input.return_to,interval_seconds:r.interval_seconds,deadline_at:r.deadline_at,repair_paths:r.repair_paths})}});
 const address=socketPath??defaultSocketPath(store.root);let reservation:ReturnType<typeof reserveEndpoint>|undefined;
 try {
  reservation=reserveEndpoint(store,address);await reclaimStaleCoreSocket(address,reservation.previous);
  const server=await startServer({root,socketPath:address,handle:async(actor,method,params)=>{
   if(method==='request')return requests.executeRequest(actor,parseRequest(params));
   if(method==='get_task_status'){
    const p=z.strictObject({task_id:z.string().optional(),for_request:z.string().optional()}).parse(params);
    if(!p.task_id)return requests.executeRequest(actor,{request_id:randomUUID(),operation:'status',...p});
    const task=new TaskService(store,workflow.workflow).get(actor,p.task_id),result=store.db.prepare('SELECT result_json,sha256 FROM task_results WHERE task_id=?').get(task.task_id);
    return {task,result:result?{value:JSON.parse(String(result.result_json)),sha256:result.sha256}:null,return:returns.getReturn(task.task_id),supervision:store.db.prepare("SELECT id,active,next_check_at FROM supervision WHERE json_extract(request_json,'$.task_id')=?").all(task.task_id),deliveries:store.db.prepare('SELECT message_id,state,native_receipt FROM deliveries WHERE task_id=?').all(task.task_id)};
   }
   if(method==='report_result'){
    const p=z.strictObject({task_id:z.string(),summary:z.string(),artifact_paths:z.array(z.string()),native_receipts:z.array(z.string()).optional(),attempt:z.number().optional(),authority_epoch:z.number().optional()}).parse(params),task=readTask(store,p.task_id),run=store.db.prepare("SELECT request_json FROM supervision WHERE json_extract(request_json,'$.task_id')=? LIMIT 1").get(p.task_id);
    const reported=await returns.reportResult(actor,p.task_id,{task_id:p.task_id,summary:p.summary,artifacts:await artifactRefs(root,store.project_id,p.artifact_paths),native_receipts:p.native_receipts??[],attempt:p.attempt??1,authority_epoch:p.authority_epoch??task.input.authority.epoch,run:run?(JSON.parse(String(run.request_json)) as {run:import('../protocol/types.js').RunIdentity}).run:null});
    if(reported.state==='result_reported' && actor.scope.operations.includes('return_to_main')){try{const delivery=await returns.returnToMain(actor,p.task_id);return {...reported,auto_return:{state:delivery.state,message_id:delivery.message_id}};}catch(error){return {...reported,auto_return:{state:'blocked',code:error instanceof BridgeError?error.code:'return_unconfirmed',recovery:'报告已保存，保留原 task/message 并核对回报；不要重复执行任务。'}};}}
    return reported;
   }
   if(method==='acknowledge_task'){
    const p=z.strictObject({task_id:z.string(),action:z.enum(['receive','verify','continue','plan_next']).default('receive'),evidence_file:z.string().optional(),next_action_id:z.string().optional(),next_instruction:z.string().optional(),next_argv:z.array(z.string()).optional(),next_artifact_paths:z.array(z.string()).optional()}).parse(params);
    if(p.action==='receive'){await returns.acknowledgeTask(actor,p.task_id);return returns.getReturn(p.task_id);}
    if(p.action==='plan_next'){await returns.configureNextAction(actor,p.task_id,{next_action_id:p.next_action_id!,instruction:p.next_instruction!,argv_sha256:digest(p.next_argv!),artifact_paths:p.next_artifact_paths!});return {state:'planned'};}
    if(!p.evidence_file)throw new BridgeError('evidence_required','缺少原主会话的实际执行回执','使用 action 命令在原会话执行核验或下一步',4);
    const evidence=JSON.parse((await scopedFile(root,p.evidence_file)).toString()) as ActionEvidence;
    if(p.action==='verify')return returns.verifyTask(actor,p.task_id,evidence);
    await returns.recordMainContinuation(actor,p.task_id,evidence as ContinuationEvidence);return returns.getReturn(p.task_id);
   }
   if(method==='request_supervision'){
    const p=z.strictObject({request_id:z.string(),original_text:z.string().optional(),dry_run:z.boolean().optional(),task_id:z.string(),run_file:z.string(),supervisor_query:z.string(),supervisor_harness:z.string().optional(),interval_seconds:z.number(),deadline_at:z.string(),repair_paths:z.array(z.string())}).parse(params),run=JSON.parse((await scopedFile(root,p.run_file)).toString());
    return requests.executeRequest(actor,parseRequest({request_id:p.request_id,operation:'supervise',task_id:p.task_id,run:run.identity??run,supervisor:{query:p.supervisor_query,...(p.supervisor_harness!==undefined?{harness:p.supervisor_harness}:{})},interval_seconds:p.interval_seconds,deadline_at:p.deadline_at,repair_paths:p.repair_paths,...(p.dry_run!==undefined?{dry_run:p.dry_run}:{}),...(p.original_text!==undefined?{original_text:p.original_text}:{})}));
   }
   throw new BridgeError('unsupported_operation','操作不可用','运行 session-bridge --help',3);
  }});
  let unpublish:()=>void;try{unpublish=reservation.publish();}catch(error){await server.close();throw error;}
  let reconciling=false;const loop=supervision.startLoop(),timer=setInterval(()=>{if(reconciling)return;reconciling=true;const rows=store.db.prepare("SELECT task_id FROM task_returns WHERE verification_json IS NOT NULL AND state!='main_continued'").all();void (async()=>{for(const row of rows)await returns.reconcileActions(String(row.task_id)).catch(()=>{});})().finally(()=>{reconciling=false;});},3000);
  return {address:server.address,close:async()=>{clearInterval(timer);await loop.close();await server.close();unpublish();store.close();}};
 }catch(error){reservation?.release();store.close();throw error;}
}
