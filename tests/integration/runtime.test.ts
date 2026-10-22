import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryLab } from '../helpers/delivery-lab.js';
import { BindingService } from '../../src/core/bindings.js';
import { runDaemon } from '../../src/cli/daemon.js';
import { issueSessionCapability } from '../../src/transport/auth.js';
import { BridgeClient } from '../../src/transport/client.js';
import { supervisionWaker } from '../../src/supervision/waker.js';
import { SupervisionService } from '../../src/supervision/leases.js';
import { StandaloneWorkflow } from '../../src/workflows/standalone.js';
import { matchesNativeAction } from '../../src/return/native-action.js';
import { digest } from '../../src/protocol/canonical.js';
import { runtimeWorkflow } from '../../src/core/runtime.js';
import type { ActionEvidence } from '../../src/return/service.js';
test('daemon_public_result_tools_share_real_task_scope_and_do_not_self_verify',async t=>{
 const f=await deliveryLab(t),dir=mkdtempSync('/tmp/sb-runtime-'),actor={...f.actor,scope:{...f.actor.scope,operations:[...f.actor.scope.operations,'context','sessions']}};const target=new BindingService(f.store);
 const worker=await target.resolve({query:'worker'}),executor={...actor,binding_id:worker[0]!.binding_id,session:worker[0]!.identity};const daemon=await runDaemon(f.root,join(dir,'core.sock'),f.registry);
 t.after(async()=>{await daemon.close();rmSync(dir,{recursive:true,force:true});});
 const sourceClient=new BridgeClient({socketPath:daemon.address,token:issueSessionCapability(f.store,actor)}),workerClient=new BridgeClient({socketPath:daemon.address,token:issueSessionCapability(f.store,executor)});
 mkdirSync(join(f.root,'output'));writeFileSync(join(f.root,'output/result.json'),'{}');
 await assert.rejects(()=>sourceClient.call(actor,'report_result',{task_id:f.task.task_id,summary:'forged',artifact_paths:['output/result.json']}));
 await workerClient.call(executor,'report_result',{task_id:f.task.task_id,summary:'done',artifact_paths:['output/result.json']});
 const status=await sourceClient.call(actor,'get_task_status',{task_id:f.task.task_id}) as {task:{state:string};result:{sha256:string}};assert.equal(status.task.state,'result_reported');assert.match(status.result.sha256,/^[a-f0-9]{64}$/);assert.equal((status as unknown as {return:{state:string}}).return.state,'return_delivered');
 await sourceClient.call(actor,'acknowledge_task',{task_id:f.task.task_id});assert.equal(f.tasks.get(f.actor,f.task.task_id).state,'result_reported');
});
test('runtime_supervision_dispatches_one_durable_native_event_and_stays_quiet_while_running',async t=>{
 const f=await deliveryLab(t),run={run_id:'run',pid:123,started_at:'birth',command_sha256:digest('cmd'),root:f.root,source_commit:'test',config_sha256:digest('config')};let terminal=false;
 const monitor=new SupervisionService({store:f.store,wake:supervisionWaker(f.store,f.registry,new StandaloneWorkflow()),observe:async()=>({identity:run,status:terminal?'completed':'running',exit_code:terminal?0:null,artifacts:[]})});
 const lease=await monitor.armSupervision(f.actor,{task_id:f.task.task_id,run,supervisor:f.task.input.target,return_to:f.actor.session,interval_seconds:1,deadline_at:f.task.input.deadline_at,repair_paths:[]});
 f.store.db.prepare('UPDATE supervision SET next_check_at=?').run('2000-01-01T00:00:00Z');assert.equal((await monitor.tick(lease.id)).state,'unchanged');assert.equal(f.store.db.prepare('SELECT count(*) n FROM deliveries').get()!.n,0);
 terminal=true;f.store.db.prepare('UPDATE supervision SET next_check_at=?').run('2000-01-01T00:00:00Z');assert.equal((await monitor.tick(lease.id)).state,'wake');assert.equal(f.store.db.prepare('SELECT count(*) n FROM deliveries').get()!.n,1);
});
test('native_action_proof_rejects_model_claims_and_requires_actual_completed_command_marker',()=>{
 const evidence={native_receipt:{action_id:'abc-123456'}} as ActionEvidence,marker='SESSIONBRIDGE_ACTION:abc-123456:'+digest('evidence'),command='node /local/dist/src/cli/main.js action --action-id abc-123456 --stdin';
 assert.equal(matchesNativeAction([{type:'agentMessage',id:'a',command,status:'completed',exitCode:0,aggregatedOutput:marker}],evidence,marker),undefined);
 assert.equal(matchesNativeAction([{type:'commandExecution',id:'a',command,status:'inProgress',exitCode:0,aggregatedOutput:marker}],evidence,marker),undefined);
 assert.equal(matchesNativeAction([{type:'commandExecution',id:'a',command,status:'completed',exitCode:0,aggregatedOutput:'done'}],evidence,marker),undefined);
 assert.equal(matchesNativeAction([{type:'commandExecution',id:'a',command,status:'completed',exitCode:0,aggregatedOutput:marker}],evidence,marker)?.id,'a');
});
test('existing_byte_state_never_silently_falls_back_to_standalone',async t=>{
 const f=await deliveryLab(t);mkdirSync(join(f.root,'.byte-os/coordination'),{recursive:true});writeFileSync(join(f.root,'.byte-os/coordination/state.json'),'{}');const runtime=runtimeWorkflow(f.store);assert.ok(runtime.roleGate);await assert.rejects(()=>runtime.roleGate!(f.actor));
});

test('source_plugin_in_another_home_finds_project_core_endpoint',async t=>{
 const f=await deliveryLab(t),dir=mkdtempSync('/tmp/sb-core-home-'),other=mkdtempSync('/tmp/sb-other-home-'),daemon=await runDaemon(f.root,join(dir,'core.sock'),f.registry),before=process.env.HOME;
 t.after(async()=>{await daemon.close();rmSync(dir,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});});
 const {createSourceConnection}=await import('../../src/core/connections.js');let source:ReturnType<typeof createSourceConnection>;
 try{process.env.HOME=other;source=createSourceConnection(f.store,new BindingService(f.store).get(f.actor.binding_id)!,{harness:'codex',kind:'native_process',sha256:digest('different-home-native')});}finally{process.env.HOME=before;}
 t.after(()=>source.close());const c=JSON.parse((await import('node:fs')).readFileSync(source.connection_file,'utf8'));assert.equal(c.socketPath,daemon.address);await new BridgeClient(c).call(c.actor,'context',{});
});

test('one_project_rejects_second_core_even_at_another_socket',async t=>{
 const f=await deliveryLab(t),dir=mkdtempSync('/tmp/sb-core-owner-'),one=await runDaemon(f.root,join(dir,'one.sock'),f.registry);t.after(async()=>{await one.close();rmSync(dir,{recursive:true,force:true});});
 await assert.rejects(()=>runDaemon(f.root,join(dir,'two.sock'),f.registry),/内核|running|已有/);
 assert.equal((await import('node:fs')).existsSync(join(dir,'one.sock')),true);
});


test('uncertain_supervision_notification_recovers_without_second_native_enqueue',async t=>{
 const f=await deliveryLab(t),deliver=f.adapter.deliver.bind(f.adapter);f.adapter.deliver=async e=>{await deliver(e);return {state:'uncertain',reason:'lost ACK'};};
 const run={run_id:'lost-ack',pid:123,started_at:'birth',command_sha256:digest('cmd'),root:f.root,source_commit:'test',config_sha256:digest('config')};
 const monitor=new SupervisionService({store:f.store,wake:supervisionWaker(f.store,f.registry,new StandaloneWorkflow()),observe:async()=>({identity:run,status:'completed',exit_code:0,artifacts:[]})}),lease=await monitor.armSupervision(f.actor,{task_id:f.task.task_id,run,supervisor:f.task.input.target,return_to:f.actor.session,interval_seconds:1,deadline_at:f.task.input.deadline_at,repair_paths:[]});
 f.store.db.prepare('UPDATE supervision SET next_check_at=?').run('2000-01-01T00:00:00Z');assert.equal((await monitor.tick(lease.id)).state,'unknown');
 f.store.db.prepare('UPDATE supervision SET next_check_at=?').run('2000-01-01T00:00:00Z');assert.equal((await monitor.tick(lease.id)).state,'wake');assert.equal(f.adapter.enqueueCount,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM deliveries').get()!.n,1);
});


test('cancelled_native_action_is_denied_before_native_owner_or_command_resolution',async t=>{
 const f=await deliveryLab(t);const {executeNativeAction}=await import('../../src/return/native-action.js');const previous=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=f.actor.session.native_session_id;
 f.store.db.prepare('INSERT INTO task_cancellations VALUES (?,?,?)').run(f.task.task_id,'test',new Date().toISOString());
 try{await assert.rejects(()=>executeNativeAction(f.store,f.actor,{task_id:f.task.task_id,purpose:'continuation',argv:[process.execPath,'-e',"throw Error('must never launch')"],artifact_paths:['output/next.json'],next_action_id:'next'},'cancelled-action'),(e:unknown)=>(e as {code:string}).code==='continuation_cancelled');}finally{if(previous===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=previous;}
});

test('native_action_rejects_wrong_fixed_next_command_before_resolving_owner',async t=>{
 const f=await deliveryLab(t),old=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=f.actor.session.native_session_id;const {executeNativeAction}=await import('../../src/return/native-action.js');
 f.store.db.prepare("UPDATE tasks SET state='verified' WHERE task_id=?").run(f.task.task_id);f.store.db.prepare('INSERT INTO task_returns(task_id,state,result_sha256,authority_json,message_id,created_at,verified_at) VALUES (?,?,?,?,?,?,?)').run(f.task.task_id,'main_acknowledged','a'.repeat(64),JSON.stringify(f.task.input.authority),'fixed-return',new Date().toISOString(),new Date().toISOString());
 f.store.db.prepare('INSERT INTO continuation_plans VALUES (?,?)').run(f.task.task_id,JSON.stringify({next_action_id:'next',instruction:'fixed',argv_sha256:digest(['allowed']),artifact_paths:['output/next.json']}));
 try{await assert.rejects(()=>executeNativeAction(f.store,f.actor,{task_id:f.task.task_id,purpose:'continuation',argv:['different'],artifact_paths:['output/next.json'],next_action_id:'next'},'wrong-command'),(e:unknown)=>(e as {code:string}).code==='next_action_mismatch');}finally{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;}
});

test('completed_native_continuation_cannot_execute_again_with_a_new_action_id',async t=>{
 const f=await deliveryLab(t),old=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=f.actor.session.native_session_id;
 f.store.db.prepare("UPDATE tasks SET state='verified' WHERE task_id=?").run(f.task.task_id);
 f.store.db.prepare('INSERT INTO task_returns(task_id,state,result_sha256,authority_json,message_id,created_at,verified_at) VALUES (?,?,?,?,?,?,?)').run(f.task.task_id,'main_continued','a'.repeat(64),JSON.stringify(f.task.input.authority),'done-return',new Date().toISOString(),new Date().toISOString());
 const {executeNativeAction}=await import('../../src/return/native-action.js');
 try{await assert.rejects(()=>executeNativeAction(f.store,f.actor,{task_id:f.task.task_id,purpose:'continuation',argv:[process.execPath,'-e','process.exit(0)'],artifact_paths:['output/new.json'],next_action_id:'already-done'},'different-action-id'),(e:unknown)=>(e as {code:string}).code==='continuation_already_completed');}
 finally{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;}
});
