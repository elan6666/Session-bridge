import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { claudeSessionStart } from '../../src/adapters/claude/hook.js';
import { digest } from '../../src/protocol/canonical.js';
import { deliveryLab } from '../helpers/delivery-lab.js';
import { BindingService,issueEnrollment } from '../../src/core/bindings.js';
import { createSourceConnection,claudeSignal } from '../../src/core/connections.js';
import { createServer } from 'node:net';
import { reserveClaudeStartup,withClaudeStartup,endClaudeStartup } from '../../src/adapters/claude/startup.js';

test('hot_reload_has_a_native_prompt_hook_for_an_already_running_session',()=>{
 const hooks=JSON.parse(readFileSync('plugins/claude/hooks/hooks.json','utf8')).hooks;
 assert.ok(hooks.UserPromptSubmit?.length,'Reloading SessionStart alone never connects an existing conversation');
});
test('native_prompt_bootstrap_reports_missing_inbox_without_guessing_a_source',async t=>{
 const f=await deliveryLab(t),saved=process.env.CLAUDE_CODE_MESSAGING_SOCKET;delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
 t.after(()=>{if(saved===undefined)delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;else process.env.CLAUDE_CODE_MESSAGING_SOCKET=saved;});
 await claudeSessionStart({hook_event_name:'UserPromptSubmit',session_id:'hot-native-session',transcript_path:join(f.root,'not-created-by-bridge.jsonl'),cwd:f.root});
 const path=join(f.root,'.session-bridge/native-diagnostics','claude-'+digest('hot-native-session')+'.json');assert.equal(existsSync(path),true);assert.equal(JSON.parse(readFileSync(path,'utf8')).reason,'native_messaging_socket_unavailable');assert.equal(existsSync(join(f.root,'not-created-by-bridge.jsonl')),false);
});
test('native_prompt_reuses_same_session_and_late_other_session_cannot_revoke_it',async t=>{
 const f=await deliveryLab(t),socket=join(f.root,'native.sock'),server=createServer();await new Promise<void>(resolve=>server.listen(socket,resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const saved=process.env.CLAUDE_CODE_MESSAGING_SOCKET;process.env.CLAUDE_CODE_MESSAGING_SOCKET=socket;t.after(()=>{if(saved===undefined)delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;else process.env.CLAUDE_CODE_MESSAGING_SOCKET=saved;});
 const old=new BindingService(f.store).get(f.actor.binding_id)!,b={...old,binding_id:'prompt-native-binding',identity:{...old.identity,harness:'claude',native_session_id:'current-native-session'}};await new BindingService(f.store).enroll(issueEnrollment(f.store),b);const source=createSourceConnection(f.store,b,claudeSignal(socket));t.after(()=>source.close());
 for(const session_id of ['current-native-session','current-native-session','late-old-session'])await claudeSessionStart({hook_event_name:'UserPromptSubmit',session_id,transcript_path:join(f.root,'native.jsonl'),cwd:f.root});
 assert.equal(new BindingService(f.store).get(b.binding_id)?.active,true);assert.equal(f.store.db.prepare("SELECT count(*) n FROM bindings WHERE json_extract(identity_json,'$.harness')='claude'").get()?.n,1);
});

test('concurrent_native_bootstraps_share_one_generation_and_old_sid_cannot_publish',async t=>{
 const f=await deliveryLab(t),path='../../src/adapters/claude/startup.js',module=await import(path).catch(()=>({}));assert.equal(typeof module.reserveClaudeStartup,'function','Native hook children need a durable startup generation');
 const signal={harness:'claude',kind:'native_socket',sha256:'test-native-signal'};
 const a=module.reserveClaudeStartup(f.store,signal,'old-sid','SessionStart');const duplicate=module.reserveClaudeStartup(f.store,signal,'old-sid','UserPromptSubmit');assert.equal(a.start,true);assert.equal(duplicate.start,false);assert.equal(duplicate.token,a.token);
 const newer=module.reserveClaudeStartup(f.store,signal,'new-sid','SessionStart');assert.notEqual(newer.token,a.token);assert.throws(()=>module.withClaudeStartup(f.store,signal,a.token,()=>{throw Error('stale publication must not execute')}),/superseded|startup/i);
 assert.throws(()=>module.reserveClaudeStartup(f.store,signal,'old-sid','UserPromptSubmit'),/changed|superseded|startup/i);let published=false;module.withClaudeStartup(f.store,signal,newer.token,()=>{published=true});assert.equal(published,true);
});
test('superseded_native_child_is_rejected_inside_the_enrollment_transaction',async t=>{
 const f=await deliveryLab(t),path='../../src/adapters/claude/startup.js',module=await import(path).catch(()=>({}));assert.equal(typeof module.reserveClaudeStartup,'function');const signal={harness:'claude',kind:'native_socket',sha256:'another-native-signal'};
 const old=module.reserveClaudeStartup(f.store,signal,'same-sid','SessionStart'),newer=module.reserveClaudeStartup(f.store,signal,'new-sid','SessionStart'),service=new BindingService(f.store),prior=service.get(f.actor.binding_id)!;
 const changed={...prior,binding_id:'late-native-child',identity:{...prior.identity,runtime_generation:'late-generation'}};await assert.rejects(()=> (service.enroll as (...args:unknown[])=>Promise<unknown>)(issueEnrollment(f.store),changed,()=>module.assertClaudeStartup(f.store,signal,old.token)),/superseded|startup/i);assert.equal(service.get(prior.binding_id)?.active,true);assert.equal(service.get(changed.binding_id),null);module.withClaudeStartup(f.store,signal,newer.token,()=>{});
});
test('a_closed_native_helper_can_reconnect_but_an_ended_sid_cannot_resurrect',async t=>{
 const f=await deliveryLab(t),signal={harness:'claude',kind:'claude_socket' as const,sha256:'closed-native-helper'},service=new BindingService(f.store),prior=service.get(f.actor.binding_id)!,binding={...prior,binding_id:'closed-helper',identity:{...prior.identity,harness:'claude',native_session_id:'owned-sid'}};await service.enroll(issueEnrollment(f.store),binding);
 const first=reserveClaudeStartup(f.store,signal,'owned-sid','SessionStart'),source=withClaudeStartup(f.store,signal,first.token,()=>createSourceConnection(f.store,binding,signal));assert.equal(reserveClaudeStartup(f.store,signal,'owned-sid','UserPromptSubmit').start,false);
 source.close();f.store.db.prepare('UPDATE bindings SET active=0 WHERE binding_id=?').run(binding.binding_id);const second=reserveClaudeStartup(f.store,signal,'owned-sid','UserPromptSubmit');assert.equal(second.start,true,'A closed helper must not leave a permanent ready reservation');assert.notEqual(second.token,first.token);
 endClaudeStartup(f.store,signal,'owned-sid');assert.throws(()=>withClaudeStartup(f.store,signal,second.token,()=>{}),/superseded|startup/i);assert.throws(()=>reserveClaudeStartup(f.store,signal,'owned-sid','UserPromptSubmit'),/changed|startup/i);
 const newer=reserveClaudeStartup(f.store,signal,'new-sid','SessionStart');endClaudeStartup(f.store,signal,'owned-sid');withClaudeStartup(f.store,signal,newer.token,()=>{});
});
