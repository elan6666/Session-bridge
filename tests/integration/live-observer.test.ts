import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryLab } from '../helpers/delivery-lab.js';
import { runCollaboration } from '../live/collaboration.js';

test('live_observer_never_adopts_an_old_target_generation_or_same_sid_foreign_profile',async t=>{
 const lab=await deliveryLab(t),path=join(lab.root,'live-map.json');
 const map={protocol_version:1,purpose:'live_acceptance',project_root:lab.root,participants:[{role:'main',binding_id:lab.actor.binding_id,identity:lab.actor.session},{role:'worker',binding_id:'replacement',identity:{...lab.task.input.target,runtime_generation:'replacement-generation'}}]};
 writeFileSync(path,JSON.stringify(map),{mode:0o600});
 const options={case:'collaboration',sessionMap:path,timeout:1};
 assert.deepEqual((await runCollaboration(options)).messages,[]);
 map.participants[1]!.identity={...lab.task.input.target,profile_id:'different-profile'};
 writeFileSync(path,JSON.stringify(map));assert.deepEqual((await runCollaboration(options)).messages,[]);
 map.participants[1]!.identity=lab.task.input.target;
 writeFileSync(path,JSON.stringify(map));assert.equal((await runCollaboration(options)).messages.length,1);
});
