import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupervisionService,type SupervisionRequest } from '../../src/supervision/leases.js';
import { observeRun } from '../../src/supervision/runs.js';
import { deliveryLab } from '../helpers/delivery-lab.js';
import type { RunProof } from '../../src/supervision/runs.js';
async function setup(t:Parameters<typeof deliveryLab>[0]){const lab=await deliveryLab(t);let now=Date.now(),wakes=0,reads=0;const run={run_id:'owned-run',pid:12345,started_at:'exact-native-start',command_sha256:'a'.repeat(64),root:lab.root,source_commit:'fixture-source',config_sha256:'b'.repeat(64)};let proof:RunProof={identity:run,status:'running',exit_code:null,artifacts:[]};const options={store:lab.store,clock:{now:()=>new Date(now)},observe:async()=>{reads++;return proof;},wake:async()=>{wakes++;}};const service=new SupervisionService(options),request:SupervisionRequest={task_id:lab.task.task_id,run,supervisor:lab.task.input.target,return_to:lab.actor.session,interval_seconds:60,deadline_at:new Date(now+86400000).toISOString(),repair_paths:[]};return {...lab,service,request,options,advance:(n=60001)=>{now+=n;},wakes:()=>wakes,reads:()=>reads,setStatus:(status:RunProof['status'])=>{proof={...proof,status,exit_code:status==='completed'?0:null};}};}
test('unchanged_state_never_wakes_model',async t=>{const f=await setup(t),lease=await f.service.armSupervision(f.actor,f.request);f.advance();assert.equal((await f.service.tick(lease.id)).state,'unchanged');assert.equal(f.wakes(),0);});
test('pid_reuse_is_unknown',async()=>{const run={run_id:'r',pid:123,started_at:'original',command_sha256:'a'.repeat(64),root:'/tmp',source_commit:'source',config_sha256:'b'.repeat(64)};const proof=await observeRun(run,async()=>({started_at:'different-owner',command_sha256:run.command_sha256}));assert.equal(proof.status,'unknown');});
test('restart_does_not_restart_job',async t=>{const f=await setup(t),lease=await f.service.armSupervision(f.actor,f.request);const restarted=new SupervisionService(f.options);assert.equal(restarted.get(lease.id)?.active,true);assert.equal(f.wakes(),0);assert.equal(f.reads(),0);});
test('sleep_backlog_coalesces',async t=>{const f=await setup(t),lease=await f.service.armSupervision(f.actor,f.request);f.advance(10*3600000);f.setStatus('completed');assert.equal((await f.service.tick(lease.id)).state,'wake');assert.equal((await f.service.tick(lease.id)).state,'unchanged');assert.equal(f.wakes(),1);assert.equal(f.reads(),1);});
test('return_disarms_lease',async t=>{const f=await setup(t),lease=await f.service.armSupervision(f.actor,f.request);await f.service.stopSupervision(f.actor,lease.id);f.advance();f.setStatus('completed');assert.equal((await f.service.tick(lease.id)).state,'stopped');assert.equal(f.wakes(),0);});
test('roles_alone_cannot_arm',async t=>{const f=await setup(t);await assert.rejects(()=>f.service.armSupervision(f.actor,{supervisor:f.request.supervisor,return_to:f.request.return_to} as SupervisionRequest));assert.equal(f.wakes(),0);});
test('actual_success_failure_and_monitor_cancel_preserve_independent_job',async t=>{
 const f=await setup(t);const {runWithReceipt}=await import('../../src/cli/run-with-receipt.js');const {digest}=await import('../../src/protocol/canonical.js');
 const success=await runWithReceipt({root:f.root,argv:[process.execPath,'-e',"setTimeout(()=>process.exit(0),2000)"],source_commit:'isolated-fixture',config_sha256:digest({case:'success'})});
 assert.equal((await observeRun(success.identity)).status,'running');const lease=await f.service.armSupervision(f.actor,{...f.request,run:success.identity});await f.service.stopSupervision(f.actor,lease.id);assert.equal((await observeRun(success.identity)).status,'running');assert.equal((await success.completion).status,'completed');assert.equal((await observeRun(success.identity)).status,'completed');
 const failure=await runWithReceipt({root:f.root,argv:[process.execPath,'-e',"setTimeout(()=>process.exit(7),2000)"],source_commit:'isolated-fixture',config_sha256:digest({case:'failure'})});assert.equal((await failure.completion).exit_code,7);const observed=await observeRun(failure.identity);assert.equal(observed.status,'failed');assert.equal(observed.exit_code,7);
 await assert.rejects(()=>runWithReceipt({root:f.root,argv:[process.execPath,'-e','process.exit(0)'],source_commit:'isolated-fixture',config_sha256:digest({case:'success'}),run_id:success.identity.run_id}),/restart|intent|already/i);
});
test('missing_program_never_claims_parent_pid_as_job',async t=>{
 const f=await setup(t);const {runWithReceipt}=await import('../../src/cli/run-with-receipt.js');await assert.rejects(()=>runWithReceipt({root:f.root,argv:['/no-such-sessionbridge-test-program'],source_commit:'fixture',config_sha256:'c'.repeat(64)}),/launch|program|spawn/i);
});
test('real_completion_event_wakes_once_and_watch_is_bounded',async t=>{
 const f=await setup(t);const {runWithReceipt}=await import('../../src/cli/run-with-receipt.js');const {watchRun}=await import('../../src/cli/supervise.js');
 const run=await runWithReceipt({root:f.root,argv:[process.execPath,'-e',"setTimeout(()=>process.exit(0),2000)"],source_commit:'isolated-native-run',config_sha256:'d'.repeat(64)});
 let wakes=0;const service=new SupervisionService({store:f.store,wake:async()=>{wakes++;}});const lease=await service.armSupervision(f.actor,{...f.request,run:run.identity,interval_seconds:1,deadline_at:new Date(Date.now()+10000).toISOString()});const loop=service.startLoop(50);t.after(()=>loop.close());
 const before=Date.now();assert.equal((await watchRun(run.identity,{timeoutMs:100,pollMs:25})).status,'running');assert.ok(Date.now()-before<1000);
 await run.completion;await loop.close();f.store.db.prepare('UPDATE supervision SET next_check_at=? WHERE id=?').run(new Date(0).toISOString(),lease.id);assert.equal((await service.tick(lease.id)).state,'wake');f.store.db.prepare('UPDATE supervision SET next_check_at=? WHERE id=?').run(new Date(0).toISOString(),lease.id);assert.equal((await service.tick(lease.id)).state,'unchanged');assert.equal(wakes,1);await service.stopSupervision(f.actor,lease.id);assert.equal(service.get(lease.id)?.active,false);
});
test('owned_exit_receipt_settles_before_waking_model',async t=>{
 const f=await setup(t);let pending=true;const service=new SupervisionService({...f.options,observe:async run=>({identity:run,status:pending?'unknown':'completed',exit_code:pending?null:0,artifacts:[],reason:pending?'awaiting_owned_exit_receipt':undefined})});const lease=await service.armSupervision(f.actor,f.request);f.advance();assert.equal((await service.tick(lease.id)).state,'unchanged');assert.equal(f.wakes(),0);f.advance(1001);assert.equal((await service.tick(lease.id)).state,'unchanged');assert.equal(f.wakes(),0);pending=false;f.advance(1001);assert.equal((await service.tick(lease.id)).state,'wake');assert.equal(f.wakes(),1);
});


test('uncertain_wake_reconciles_same_durable_event_after_restart',async t=>{
 const f=await setup(t),events:{event_id:string;message_id:string}[]=[];
 const options={...f.options,wake:async(_lease:unknown,event:{event_id:string;message_id:string})=>{events.push(event);if(events.length===1)throw new Error('temporary target unavailable');}};
 const first=new SupervisionService(options),lease=await first.armSupervision(f.actor,f.request);f.setStatus('completed');f.advance();assert.equal((await first.tick(lease.id)).state,'unknown');
 const restarted=new SupervisionService(options);f.advance();assert.equal((await restarted.tick(lease.id)).state,'wake');assert.equal(events.length,2);assert.deepEqual(events[0],events[1]);f.advance();assert.equal((await restarted.tick(lease.id)).state,'unchanged');assert.equal(events.length,2);
});


test('only_exact_active_supervisor_can_read_its_task',async t=>{
 const f=await setup(t);const {binding}=await import('../helpers/bindings.js');const {BindingService,issueEnrollment}=await import('../../src/core/bindings.js');
 const b=binding(f.store,{alias:'independent-supervisor'});b.identity.native_session_id='third-supervisor';await new BindingService(f.store).enroll(issueEnrollment(f.store),b);
 const actor={...f.actor,binding_id:b.binding_id,session:b.identity};assert.throws(()=>f.tasks.get(actor,f.task.task_id),/participant/i);
 const lease=await f.service.armSupervision(f.actor,{...f.request,supervisor:b.identity});assert.equal(f.tasks.get(actor,f.task.task_id).task_id,f.task.task_id);await f.service.stopSupervision(f.actor,lease.id);assert.throws(()=>f.tasks.get(actor,f.task.task_id),/participant/i);
});
