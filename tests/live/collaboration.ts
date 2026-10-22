import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from '../../src/core/database.js';
import { readLiveMap,type LiveOptions } from './common/options.js';
import { newLiveReceipt,type LiveReceipt } from './common/evidence.js';
import { verifyArtifact } from '../../src/core/artifacts.js';
import { preflightLive } from './preflight.js';
import { sessionKey } from '../../src/protocol/canonical.js';
export async function runCollaboration(options:LiveOptions):Promise<LiveReceipt>{
 const map=await readLiveMap(options),receipt=newLiveReceipt(options),preflight=await preflightLive(options),store=openStore(map.project_root);receipt.kind='observe_original_source_driven_collaboration';
 try{
  const tasks=store.db.prepare('SELECT t.task_id,t.state,t.input_json,r.result_json FROM tasks t LEFT JOIN task_results r ON r.task_id=t.task_id').all();
  for(const row of tasks){const input=JSON.parse(String(row.input_json));if(![input.source,input.target].every(identity=>map.participants.some(p=>sessionKey(p.identity)===sessionKey(identity))))continue;const result=row.result_json?JSON.parse(String(row.result_json)):null;receipt.messages.push({task_id:row.task_id,target_harness:input.target.harness,state:row.state,artifact_count:result?.artifacts.length??0});if(result)for(const ref of result.artifacts)receipt.artifacts.push({...ref,verified:await verifyArtifact(store.root,ref)});}
  const required=['workspace/report_tool.py','workspace/README.zh.md','workspace/tests/test_report_tool.py'];let present=true;for(const path of required)try{await readFile(join(store.root,path));}catch{present=false;}
  receipt.checks.expected_files_present=present;receipt.checks.artifact_verified=receipt.artifacts.length>0 && receipt.artifacts.every(a=>(a as {verified:boolean}).verified);
  const full=preflight.status==='passed' && present && receipt.checks.artifact_verified && ['claude','dsh','hermes','pi'].every(h=>receipt.messages.some(m=>(m as {target_harness:string;state:string}).target_harness===h && ['result_reported','verified'].includes((m as {state:string}).state)));
  receipt.status=full?'untested':'blocked';receipt.blockers=preflight.participants.filter(p=>!p.native_context).map(p=>({code:'native_harness_not_verified',reason:p.harness+': '+p.reason,recovery:'在明确选定的原生会话启用连接器，完成模型工具探测后再验收；不以新 SDK 代替原 Host。'}));
  receipt.limitations.push('Read-only observer, not a model-dispatch substitute. Full acceptance also requires sealed holdout checks, actual native contributions, main continuation and owned-resource cleanup receipts.');receipt.finished_at=new Date().toISOString();return receipt;
 }finally{store.close();}
}
