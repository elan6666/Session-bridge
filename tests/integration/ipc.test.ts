import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { initProject } from '../../src/cli/init.js';
import { openStore } from '../../src/core/database.js';
import { BindingService, issueEnrollment } from '../../src/core/bindings.js';
import { startServer } from '../../src/transport/server.js';
import { BridgeClient } from '../../src/transport/client.js';
import { issueSessionCapability } from '../../src/transport/auth.js';
import { JsonLines } from '../../src/transport/framing.js';
import { binding } from '../helpers/bindings.js';
import type { Actor } from '../../src/protocol/types.js';
async function lab(t:{after:(fn:()=>void|Promise<void>)=>void}){const root=mkdtempSync('/tmp/sb-ipc-');await initProject(root,{dryRun:false});const store=openStore(root);const b=binding(store);const svc=new BindingService(store);await svc.enroll(issueEnrollment(store),b);const actor:Actor={session:b.identity,binding_id:b.binding_id,scope:{project_id:store.project_id,task_ids:['task-1'],operations:['context','sessions']}};const token=issueSessionCapability(store,actor);const socketPath=join(root,'.session-bridge','ipc.sock');const server=await startServer({root,socketPath});t.after(async()=>{await server.close();store.close();rmSync(root,{recursive:true,force:true});});return {root,store,actor,token,server,svc,client:new BridgeClient({socketPath,token})};}
test('cross_project_scope_denied',async t=>{const {client,actor}=await lab(t);await assert.rejects(()=>client.call({...actor,scope:{...actor.scope,project_id:'other'}},'context',{}));});
test('text_cannot_forge_actor',async t=>{const {client,actor}=await lab(t);const result=await client.call(actor,'context',{actor:{...actor,session:{...actor.session,native_session_id:'forged'}}}) as {actor:Actor};assert.deepEqual(result.actor,actor);});
test('partial_frame_is_bounded',()=>{let now=1000;const f=new JsonLines({now:()=>new Date(now)});f.push(Buffer.from('{'));now=6001;assert.throws(()=>f.checkTimeout(),/frame|deadline/i);assert.throws(()=>new JsonLines().push(Buffer.alloc(65537,120)),/large|limit/i);});
test('socket_is_private_and_revoke_is_immediate',async t=>{const {client,actor,server,root,svc}=await lab(t);assert.equal(statSync(server.address).mode&0o777,0o600);assert.equal(statSync(join(root,'.session-bridge')).mode&0o777,0o700);assert.ok(await client.call(actor,'context',{}));await svc.revoke(actor,actor.binding_id);await assert.rejects(()=>client.call(actor,'context',{}));});

test('context_supplies_unique_request_ids',async t=>{const {client,actor}=await lab(t);const first=await client.call(actor,'context',{}) as {request_id:string};const second=await client.call(actor,'context',{}) as {request_id:string};assert.match(first.request_id,/^[a-f0-9-]{36}$/);assert.notEqual(first.request_id,second.request_id);});

test('stdin_request_preserves_text_through_real_cli_and_ipc',async t=>{
 const {deliveryLab}=await import('../helpers/delivery-lab.js');
 const {writeFileSync}=await import('node:fs');
 const {spawn}=await import('node:child_process');
 const {runDaemon}=await import('../../src/cli/daemon.js');
 const lab=await deliveryLab(t),dir=mkdtempSync('/tmp/sb-cli-');
 const actor={...lab.actor,scope:{...lab.actor.scope,operations:[...lab.actor.scope.operations,'context']}};
 const token=issueSessionCapability(lab.store,actor),socketPath=join(dir,'bridge.sock');
 const daemon=await runDaemon(lab.root,socketPath,lab.registry);
 try {
  const connection=join(lab.root,'.session-bridge','cli-context.json');
  writeFileSync(connection,JSON.stringify({socketPath,token,actor}),{mode:0o600});
  const sentinel=join(lab.root,'CLI_SENTINEL');const original='原样保留“空 格” $(touch '+sentinel+')';
  const request={operation:'delegate',request_id:'real-cli-data',target:{query:'worker'},goal:original,original_text:original,acceptance:['原文不变'],read_paths:['.'],write_paths:['output'],deadline_at:'2099-01-01T00:00:00Z'};
  const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
   const child=spawn(process.execPath,['dist/src/cli/main.js','request','--stdin','--json'],{env:{...process.env,SESSIONBRIDGE_CONNECTION:connection,CODEX_THREAD_ID:actor.session.native_session_id},stdio:['pipe','pipe','pipe']});
   let stdout='',stderr='';const timeout=setTimeout(()=>{child.kill();reject(new Error('Owned CLI test timed out'));},5000);
   child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);resolve({code,stdout,stderr});});child.stdin.end(JSON.stringify(request));
  });
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).result.task.input.goal,original);
  const {existsSync}=await import('node:fs');assert.equal(existsSync(sentinel),false);assert.equal(lab.adapter.enqueueCount,1);
 } finally {await daemon.close();rmSync(dir,{recursive:true,force:true});}
});
