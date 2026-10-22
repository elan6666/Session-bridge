import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readdirSync,rmSync } from 'node:fs';
import { validateCodexBinary } from '../../src/adapters/codex/version.js';
import { CodexStdio } from '../../src/adapters/codex/stdio.js';
import { BUNDLED_CODEX,HAS_BUNDLED_CODEX,codexLab } from '../helpers/codex-lab.js';
const native={skip:!HAS_BUNDLED_CODEX,timeout:45_000};
test('writer_never_loads_target',native,async t=>{const lab=await codexLab(t);const envelope=lab.envelope('[PROBE_REPLY:EXTERNAL]');const outcome=await lab.adapter.deliver(envelope);assert.equal(outcome.state,'confirmed');const client=new CodexStdio({binary:BUNDLED_CODEX,codexHome:lab.home,cwd:lab.workspace});try{for(const method of ['thread/start','thread/resume','turn/start','thread/queue/start','turn/interrupt'])await assert.rejects(()=>client.request(method,{}),/forbidden|allowlist/i);const loaded=await client.request('thread/loaded/list',{}) as {data:string[]};assert.deepEqual(loaded.data,[]);}finally{await client.close();}assert.ok(lab.trace.includes('thread/queue/add'));assert.equal(lab.trace.some(m=>['thread/start','thread/resume','turn/start','thread/queue/start'].includes(m)),false);const started=await lab.owner.wait('item/started',p=>(p.item as {clientId?:string})?.clientId===envelope.message_id);await lab.complete(String(started.turnId));assert.equal((await lab.adapter.reconcile(envelope))[0]?.state,'completed');});
test('version_drift_blocks_writer',native,async t=>{const root=mkdtempSync('/tmp/sb-version-');t.after(()=>rmSync(root,{recursive:true,force:true}));const before=readdirSync(root);await assert.rejects(()=>validateCodexBinary(BUNDLED_CODEX,'0.0.0-wrong'),/version|drift/i);assert.deepEqual(readdirSync(root),before);});
test('cold_interrupted_is_unknown',native,async t=>{const lab=await codexLab(t),envelope=lab.envelope('[PROBE_HOLD:cold][PROBE_REPLY:AFTER_HOLD]');const id=await lab.turn(lab.wireText(envelope),envelope.message_id);await lab.waitHold('cold');try{const observations=await lab.adapter.reconcile(envelope);assert.ok(observations.length>0);assert.equal(observations[0]?.state,'unknown');assert.equal(observations[0]?.native_receipt,'turn:'+id);const reader=new CodexStdio({binary:BUNDLED_CODEX,codexHome:lab.home,cwd:lab.workspace});try{const history=await reader.request('thread/turns/list',{threadId:lab.target.native_session_id,itemsView:'full',limit:20}) as {data:{id:string;status:string}[]};assert.equal(history.data.find(turn=>turn.id===id)?.status,'interrupted');}finally{await reader.close();}const original=await lab.owner.request('thread/read',{threadId:lab.target.native_session_id}) as {thread:{status:{type:string}}};assert.equal(original.thread.status.type,'active');}finally{lab.model.release('cold');await lab.complete(id);}});
test('busy_queue_waits',native,async t=>{const lab=await codexLab(t);const busy=await lab.turn('[PROBE_HOLD:busy][PROBE_REPLY:BUSY_DONE]');await lab.waitHold('busy');const envelope=lab.envelope('[PROBE_REPLY:QUEUED_DONE]');assert.equal((await lab.adapter.deliver(envelope)).state,'confirmed');const observations=await lab.adapter.reconcile(envelope);assert.equal(observations[0]?.state,'queued');assert.equal(lab.owner.events.some(e=>e.method==='item/started' && (e.params?.item as {clientId?:string})?.clientId===envelope.message_id),false);lab.model.release('busy');await lab.complete(busy);const event=await lab.owner.wait('item/started',p=>(p.item as {clientId?:string})?.clientId===envelope.message_id);await lab.complete(String(event.turnId));assert.equal((await lab.adapter.reconcile(envelope)).some(o=>o.state==='completed'),true);});

test('native_queue_receipt_is_not_receiver_acceptance',async t=>{
 const {deliveryLab}=await import('../helpers/delivery-lab.js');const lab=await deliveryLab(t);
 const deliver=lab.adapter.deliver.bind(lab.adapter);lab.adapter.deliver=async envelope=>{await deliver(envelope);return {state:'uncertain',reason:'ACK lost'};};
 lab.adapter.reconcile=async envelope=>[{state:'queued',message_id:envelope.message_id,session:envelope.target,native_receipt:'queue-entry',artifacts:[]}];
 await lab.service.send(lab.actor,lab.envelope);const result=await lab.service.recover(lab.actor,lab.envelope.message_id);
 assert.equal(result.state,'transport_confirmed');assert.equal(lab.tasks.get(lab.actor,lab.task.task_id).state,'ready');
});

test('binding_from_another_profile_cannot_use_this_writer',native,async t=>{
 const {createCodexAdapter}=await import('../../src/adapters/codex/adapter.js');const lab=await codexLab(t);const binding=(await lab.adapter.discover())[0]!;const trace:string[]=[];
 const wrong=createCodexAdapter({desktopBinary:BUNDLED_CODEX,codexHome:lab.home,expectedVersion:'0.163.0-alpha.11',projectRoot:lab.workspace,resolveBinding:async()=>({...binding,endpoint_ref:'wrong-profile'}),trace:m=>trace.push(m)});
 try{assert.equal((await wrong.deliver(lab.envelope('must not enqueue'))).state,'refused');assert.equal(trace.includes('thread/queue/add'),false);}finally{await wrong.disconnect('');}
});

test('stopped_original_owner_is_not_replaced_by_writer',native,async t=>{const lab=await codexLab(t);await lab.owner.close();const before=lab.trace.length;assert.equal((await lab.adapter.deliver(lab.envelope('do not take over'))).state,'refused');assert.equal(lab.trace.slice(before).includes('thread/queue/add'),false);});

test('live_without_explicit_map_has_no_target_or_delivery',async()=>{const {runLiveCase}=await import('../live/run.js');const receipt=await runLiveCase({harness:'codex',case:'attached',timeout:180});assert.equal(receipt.status,'blocked');assert.equal(receipt.blockers[0]?.code,'explicit_session_map_required');assert.deepEqual(receipt.participants,[]);assert.deepEqual(receipt.messages,[]);assert.equal(receipt.task,null);});

test('external_live_driver_never_borrows_main_capability',async()=>{
 const {runCodexLive}=await import('../live/codex.js');
 const {newLiveReceipt}=await import('../live/common/evidence.js');
 const options={case:'attached',timeout:1};
 await assert.rejects(()=>runCodexLive(options,{protocol_version:1,purpose:'live_acceptance',project_root:'/not-an-open-project',participants:[]},newLiveReceipt(options)),(e:unknown)=>(e as {code:string}).code==='original_source_execution_required');
});
