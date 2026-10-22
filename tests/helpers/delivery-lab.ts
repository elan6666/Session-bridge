import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initProject } from '../../src/cli/init.js';
import { openStore } from '../../src/core/database.js';
import { BindingService, issueEnrollment } from '../../src/core/bindings.js';
import { TaskService } from '../../src/core/tasks.js';
import { DeliveryService } from '../../src/core/delivery.js';
import { StandaloneWorkflow, scopeDigest } from '../../src/workflows/standalone.js';
import { AdapterRegistry } from '../../src/adapters/registry.js';
import { FakeAdapter } from '../../src/adapters/fake.js';
import { sessionKey,digest } from '../../src/protocol/canonical.js';
import type { Actor, Envelope, TaskInput } from '../../src/protocol/types.js';
import { binding } from './bindings.js';
import { tempRoot } from './fixtures.js';
export async function deliveryLab(t:{after:(fn:()=>void|Promise<void>)=>void}){
 const {root,cleanup}=tempRoot();await initProject(root,{dryRun:false});const store=openStore(root),svc=new BindingService(store),a=binding(store),b=binding(store,{alias:'worker'});b.identity={...b.identity,native_session_id:'worker'};await svc.enroll(issueEnrollment(store),a);await svc.enroll(issueEnrollment(store),b);
 const actor:Actor={binding_id:a.binding_id,session:a.identity,scope:{project_id:store.project_id,task_ids:['*'],operations:['delegate_task','get_task_status','recover_delivery','configure_roles','acknowledge_task','report_result','return_to_main','request_supervision','cancel_pending']}};
 const base={source:a.identity,target:b.identity,goal:'汇总 CSV',acceptance:['完成真实输出'],read_paths:['.'],write_paths:['output'],return_to:a.identity,deadline_at:'2099-01-01T00:00:00Z'};
 const input:TaskInput={...base,authority:{workflow:'standalone',handoff_id:null,epoch:0,owner_session_key:sessionKey(a.identity),scope_digest:scopeDigest(base)}};
 const tasks=new TaskService(store,new StandaloneWorkflow()),task=await tasks.create(actor,input),nativePath=join(root,'.session-bridge','native.sqlite'),adapter=new FakeAdapter(nativePath),registry=new AdapterRegistry();registry.register('codex',adapter);const service=new DeliveryService(store,registry);
 const body={text:'来源为外部 Agent 的任务',artifacts:[]};const envelope:Envelope={protocol_version:1,message_id:randomUUID(),task_id:task.task_id,handoff_id:null,authority_epoch:0,sender:a.identity,target:b.identity,kind:'task',body,body_sha256:digest(body),created_at:new Date().toISOString(),expires_at:'2099-01-01T00:00:00Z',causation_id:null,correlation_id:task.task_id};
 t.after(async()=>{await adapter.disconnect('');store.close();cleanup();});return {root,store,actor,task,envelope,adapter,registry,service,tasks,nativePath};
}
