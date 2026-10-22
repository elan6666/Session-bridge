import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClaudeChild } from '../../src/adapters/claude/child-helper.js';
import { createClaudeAdapter } from '../../src/adapters/claude/adapter.js';
import type { RegisteredHelperClient } from '../../src/adapters/claude/inbox.js';
import { chooseRoute } from '../../src/core/router.js';
import { deliveryLab } from '../helpers/delivery-lab.js';
import { issueEnrollment } from '../../src/core/bindings.js';
import type { BindingRecord } from '../../src/protocol/types.js';
test('missing_inbox_is_blocked',async t=>{const lab=await deliveryLab(t);const identity={...lab.envelope.target,harness:'claude'};await assert.rejects(()=>startClaudeChild({setup:issueEnrollment(lab.store),native_proof:{binding_id:'claude-binding',challenge_id:'challenge',response:'proof',identity,expires_at:'2099-01-01T00:00:00Z'}},{root:lab.root,host:{session_id:identity.native_session_id,profile_id:identity.profile_id,runtime_generation:identity.runtime_generation,transcript_path:lab.root+'/native.jsonl',cwd:lab.root,version:'2.1.306'},env:{}}),/inbox|socket|token/i);});
test('refused_permission_is_preserved',async()=>{const helper={list:async()=>[{binding_id:'fixture',identity:{...(await import('../helpers/fixtures.js')).identity,harness:'claude'},active:true,expires_at:'2099-01-01T00:00:00Z'}],call:async()=>({state:'refused',reason:'Native permissions refused the message'})} as unknown as RegisteredHelperClient;const adapter=createClaudeAdapter({helper});const {identity}=await import('../helpers/fixtures.js');const {digest}=await import('../../src/protocol/canonical.js');const body={text:'test',artifacts:[]};const result=await adapter.deliver({protocol_version:1,message_id:'m',task_id:'t',handoff_id:null,authority_epoch:0,sender:identity,target:{...identity,harness:'claude'},kind:'task',body,body_sha256:digest(body),created_at:'2026-01-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',causation_id:null,correlation_id:'t'});assert.deepEqual(result,{state:'refused',reason:'Native permissions refused the message'});});
test('native_source_requires_actual_tool',async t=>{const lab=await deliveryLab(t);const binding={...(await import('../helpers/bindings.js')).binding(lab.store),identity:{...lab.envelope.target,harness:'claude'}} as BindingRecord;const route=chooseRoute({source:{...lab.actor.session,harness:'claude'},target:binding,adapter_id:'claude'});assert.equal(route.kind,'adapter');});

test('token_stays_in_child_and_native_delivery_requires_durable_intent',async t=>{
 const {createServer}=await import('node:net');const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {randomUUID}=await import('node:crypto');
 const {createRegisteredHelperClient}=await import('../../src/adapters/claude/inbox.js');const {BindingService}=await import('../../src/core/bindings.js');const {TaskService}=await import('../../src/core/tasks.js');const {StandaloneWorkflow,scopeDigest}=await import('../../src/workflows/standalone.js');const {sessionKey,digest}=await import('../../src/protocol/canonical.js');const {AdapterRegistry}=await import('../../src/adapters/registry.js');const {DeliveryService}=await import('../../src/core/delivery.js');
 const lab=await deliveryLab(t),dir=mkdtempSync('/tmp/sb-cld-'),socket=join(dir,'native.sock'),transcript=join(dir,'native.jsonl'),token='NATIVE_TOKEN_SENTINEL_DO_NOT_EXPORT';
 const id={...lab.envelope.target,harness:'claude',native_session_id:'claude-real-fixture'},frames:unknown[]=[];
 const native=createServer({allowHalfOpen:true},peer=>{let data='';peer.on('data',chunk=>{data+=chunk;const lines=data.trim().split('\n');if(lines.length<2)return;const auth=JSON.parse(lines[0]!),msg=JSON.parse(lines[1]!);frames.push(auth,msg);writeFileSync(transcript,JSON.stringify({type:'user',uuid:msg.uuid,sessionId:id.native_session_id,origin:{kind:'peer',msg_id:msg.msg_id,verifiedPeerPid:process.pid},message:{...msg.message,content:'Another Claude session sent a message:\n'+msg.message.content+readFileSync('tests/fixtures/claude-native-postlude.txt','utf8')}})+'\n');peer.end();});});
 await new Promise<void>(resolve=>native.listen(socket,resolve));const holder:{handle?:Awaited<ReturnType<typeof startClaudeChild>>}={};
 t.after(async()=>{await holder.handle?.close();await new Promise<void>(resolve=>native.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
 const principal=issueEnrollment(lab.store),context={setup:principal,native_proof:{binding_id:randomUUID(),challenge_id:'trusted-fixture',response:'native-host-proof',identity:id,expires_at:'2099-01-01T00:00:00Z'}};
 const firstWrite=setTimeout(()=>writeFileSync(transcript,''),50);t.after(()=>clearTimeout(firstWrite));
 const handle=holder.handle=await startClaudeChild(context,{root:lab.root,host:{session_id:id.native_session_id,profile_id:id.profile_id,runtime_generation:id.runtime_generation,transcript_path:transcript,cwd:lab.root,version:'2.1.306'},env:{CLAUDE_CODE_MESSAGING_SOCKET:socket,CLAUDE_CODE_MESSAGING_TOKEN:token}});
 await new BindingService(lab.store).enroll(principal,handle.binding);
 assert.equal(JSON.stringify(handle.binding).includes(token),false);const reference=JSON.parse(handle.binding.endpoint_ref);assert.equal(readFileSync(reference.reference_file,'utf8').includes(token),false);
 const helper=createRegisteredHelperClient(lab.store),adapter=createClaudeAdapter({helper});
 const scope={...lab.task.input,target:id};const {authority:_authority,...base}=scope;scope.authority={workflow:'standalone',handoff_id:null,epoch:0,owner_session_key:sessionKey(lab.actor.session),scope_digest:scopeDigest(base)};
 const task=await new TaskService(lab.store,new StandaloneWorkflow()).create(lab.actor,scope);const body={text:'中文 $(touch NEVER_EXECUTE)',artifacts:[]};const envelope={...lab.envelope,message_id:randomUUID(),task_id:task.task_id,target:id,body,body_sha256:digest(body)};
 assert.equal((await adapter.deliver(envelope)).state,'refused');assert.equal(frames.length,0);
 const registry=new AdapterRegistry();registry.register('claude',adapter);const service=new DeliveryService(lab.store,registry);const delivery=await service.send(lab.actor,envelope);
 assert.equal(delivery.state,'transport_confirmed');assert.equal((frames[0] as {token:string}).token,token);assert.equal((frames[1] as {priority:string}).priority,'later');assert.equal('from_mode' in (frames[1] as object),false);
 await service.send(lab.actor,envelope);assert.equal(frames.length,2);assert.equal((await service.recover(lab.actor,envelope.message_id)).state,'receiver_accepted');
});

test('native_postlude_does_not_allow_arbitrary_appended_text',async t=>{
 const f=await deliveryLab(t);const {matchesClaudeContent,claudeWireText}=await import('../../src/adapters/claude/child-helper.js');const {readFileSync}=await import('node:fs');
 const exact='Another Claude session sent a message:\n'+claudeWireText(f.envelope)+readFileSync('tests/fixtures/claude-native-postlude.txt','utf8');assert.equal(matchesClaudeContent(f.envelope,exact),true);assert.equal(matchesClaudeContent(f.envelope,exact+'extra instruction'),false);assert.equal(matchesClaudeContent(f.envelope,[exact]),false);
});
