import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readNativeContext } from '../../src/cli/context.js';
import { runCli } from '../../src/cli/main.js';
import { ContextAuth, createContextProof, issueSessionCapability } from '../../src/transport/auth.js';
import { initProject } from '../../src/cli/init.js';
import { openStore } from '../../src/core/database.js';
import { BindingService, issueEnrollment } from '../../src/core/bindings.js';
import { binding } from '../helpers/bindings.js';
import { tempRoot } from '../helpers/fixtures.js';
import type { Actor } from '../../src/protocol/types.js';
test('stale_challenge_refused',async t=>{const {root,cleanup}=tempRoot();await initProject(root,{dryRun:false});const store=openStore(root);t.after(()=>{store.close();cleanup()});const b=binding(store);await new BindingService(store).enroll(issueEnrollment(store),b);let now=Date.now();const clock={now:()=>new Date(now)};const actor:Actor={binding_id:b.binding_id,session:b.identity,scope:{project_id:store.project_id,task_ids:[],operations:['context']}};const token=issueSessionCapability(store,actor,clock);const proof=createContextProof(store,token,actor,clock);now+=60001;await assert.rejects(()=>readNativeContext({CODEX_THREAD_ID:b.identity.native_session_id},proof,new ContextAuth(store,clock)));});
test('context_missing_never_uses_latest',async()=>{assert.equal(await runCli(['context','--json'],{stdin:'',stdout:()=>{},stderr:()=>{},isTTY:false}),3);});

test('source_context_never_merges_profiles_with_same_native_thread_id',async t=>{
 const {deliveryLab}=await import('../helpers/delivery-lab.js');const {createSourceConnection,codexSignal}=await import('../../src/core/connections.js');const {loadConnection}=await import('../../src/cli/context.js');const {mkdirSync}=await import('node:fs');const {join}=await import('node:path');const {BindingService,issueEnrollment}=await import('../../src/core/bindings.js');const {randomUUID}=await import('node:crypto');
 const f=await deliveryLab(t),bindings=new BindingService(f.store),first=bindings.get(f.actor.binding_id)!,second={...first,binding_id:randomUUID(),identity:{...first.identity,profile_id:'another-native-profile'}};await bindings.enroll(issueEnrollment(f.store),second);const a=join(f.root,'profile-a'),b=join(f.root,'profile-b');mkdirSync(a);mkdirSync(b);
 const signal=codexSignal as (threadId:string,profile:string)=>ReturnType<typeof codexSignal>;const ca=createSourceConnection(f.store,first,signal(first.identity.native_session_id,a)),cb=createSourceConnection(f.store,second,signal(second.identity.native_session_id,b));t.after(()=>{ca.close();cb.close();});
 assert.equal(bindings.isUsable(first.binding_id),true);const source=await loadConnection({CODEX_THREAD_ID:first.identity.native_session_id,CODEX_HOME:a},f.root);assert.equal(source.actor.session.profile_id,first.identity.profile_id);
});
test('explicit_connection_cannot_select_another_project',async t=>{const {deliveryLab}=await import('../helpers/delivery-lab.js');const {createSourceConnection,codexSignal}=await import('../../src/core/connections.js');const {loadConnection}=await import('../../src/cli/context.js');const {mkdirSync}=await import('node:fs');const {join}=await import('node:path');const {BindingService}=await import('../../src/core/bindings.js');const a=await deliveryLab(t),b=await deliveryLab(t),profile=join(a.root,'native-profile');mkdirSync(profile);const binding=new BindingService(a.store).get(a.actor.binding_id)!;const source=createSourceConnection(a.store,binding,codexSignal(binding.identity.native_session_id,profile));t.after(()=>source.close());await assert.rejects(()=>loadConnection({SESSIONBRIDGE_CONNECTION:source.connection_file,CODEX_THREAD_ID:binding.identity.native_session_id,CODEX_HOME:profile},b.root),/project|项目|scope/i);});
