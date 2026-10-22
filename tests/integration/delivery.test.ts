import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryLab } from '../helpers/delivery-lab.js';
import { digest } from '../../src/protocol/canonical.js';
import { DeliveryService } from '../../src/core/delivery.js';
import { chooseRoute } from '../../src/core/router.js';
import { BindingService } from '../../src/core/bindings.js';
test('two_senders_enqueue_once',async t=>{const {actor,envelope,service,adapter}=await deliveryLab(t);await Promise.all([service.send(actor,envelope),service.send(actor,envelope)]);assert.equal(adapter.enqueueCount,1);const record=await service.send(actor,envelope);assert.equal(record.state,'transport_confirmed');assert.equal(adapter.enqueueCount,1);});
test('same_id_different_body_rejected',async t=>{const {actor,envelope,service}=await deliveryLab(t);await service.send(actor,envelope);const body={text:'different',artifacts:[]};await assert.rejects(()=>service.send(actor,{...envelope,body,body_sha256:digest(body)}),/conflict|different/i);});
test('unknown_never_blind_resends',async t=>{const {actor,envelope,service,adapter}=await deliveryLab(t);adapter.deliver=async()=>({state:'uncertain',reason:'lost reply'});const record=await service.send(actor,envelope);assert.equal(record.state,'uncertain');adapter.deliver=async()=>{throw new Error('must not retry')};assert.equal((await service.send(actor,envelope)).state,'uncertain');assert.equal((await service.recover(actor,envelope.message_id)).state,'uncertain');assert.equal(adapter.enqueueCount,0);});
test('native_route_does_not_also_call_adapter',async t=>{const {store,registry,actor,envelope,adapter}=await deliveryLab(t);let calls=0;const native={tool_name:'SendMessage',evidence:'actual test host capability',deliver:async()=>{calls++;return {state:'confirmed' as const,native_receipt:'native-1'}}};const service=new DeliveryService(store,registry,{native});assert.equal((await service.send(actor,envelope)).state,'transport_confirmed');assert.equal(calls,1);assert.equal(adapter.enqueueCount,0);const target=(await new BindingService(store).resolve({query:'worker'}))[0]!;assert.equal(chooseRoute({source:actor.session,target,adapter_id:'codex'}).kind,'adapter');});
test('transport_accepted_provider_failed_is_not_completed',async t=>{const {actor,envelope,service,task,tasks}=await deliveryLab(t);await service.send(actor,envelope);const observation={state:'unknown' as const,message_id:envelope.message_id,session:envelope.target,native_receipt:'provider-auth-failed',artifacts:[]};await tasks.observe(actor,task.task_id,observation);assert.equal(tasks.get(actor,task.task_id).state,'ready');assert.notEqual(tasks.get(actor,task.task_id).state,'verified');});

test('completed_observation_requires_independent_verification',async t=>{const {actor,envelope,service,task,tasks}=await deliveryLab(t);await service.send(actor,envelope);await tasks.observe(actor,task.task_id,{state:'completed',message_id:envelope.message_id,session:envelope.target,native_receipt:'real-turn-1',artifacts:[]});assert.equal(tasks.get(actor,task.task_id).state,'result_reported');await tasks.observe(actor,task.task_id,{state:'accepted',message_id:envelope.message_id,session:envelope.target,native_receipt:'older-ack',artifacts:[]});assert.equal(tasks.get(actor,task.task_id).state,'result_reported');});


test('cancel_wins_before_first_delivery_intent_even_across_async_binding_check',async t=>{
 const f=await deliveryLab(t);const {RequestService}=await import('../../src/cli/request.js');
 const sending=f.service.send(f.actor,f.envelope);const rejected=assert.rejects(sending,(e:unknown)=>(e as {code:string}).code==='future_delivery_cancelled');
 const cancelled=await new RequestService({store:f.store,registry:f.registry}).executeRequest(f.actor,{request_id:'cancel-race',operation:'cancel_pending',task_id:f.task.task_id});
 assert.equal(cancelled.state,'executed');await rejected;assert.equal(f.adapter.enqueueCount,0);assert.equal(f.service.get(f.envelope.message_id),null);
});
