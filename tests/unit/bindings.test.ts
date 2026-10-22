import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initProject } from '../../src/cli/init.js';
import { openStore } from '../../src/core/database.js';
import { BindingService, issueEnrollment } from '../../src/core/bindings.js';
import { tempRoot } from '../helpers/fixtures.js';
import { binding } from '../helpers/bindings.js';
async function lab(t:{after:(fn:()=>void)=>void}){const {root,cleanup}=tempRoot();await initProject(root,{dryRun:false});const store=openStore(root);t.after(()=>{store.close();cleanup()});return {store,svc:new BindingService(store)};}
test('alias_collision_requires_choice',async t=>{const {store,svc}=await lab(t);const a=binding(store),b=binding(store);b.identity.native_session_id='different';await svc.enroll(issueEnrollment(store),a);await svc.enroll(issueEnrollment(store),b);assert.equal((await svc.resolve({query:'监督'})).length,2);});
test('new_generation_revokes_old',async t=>{const {store,svc}=await lab(t);const old=binding(store);await svc.enroll(issueEnrollment(store),old);const current=binding(store,{identity:{...old.identity,runtime_generation:'gen2'}});await svc.enroll(issueEnrollment(store),current);assert.equal(svc.isUsable(old.binding_id),false);assert.equal(svc.isUsable(current.binding_id),true);assert.equal((await svc.resolve({query:'监督'})).length,1);});
test('different_profile_is_not_same_session',async t=>{const {store,svc}=await lab(t);const a=binding(store);await svc.enroll(issueEnrollment(store),a);await svc.enroll(issueEnrollment(store),binding(store,{identity:{...a.identity,profile_id:'other'}}));assert.equal((await svc.resolve({query:'监督'})).length,2);assert.equal((await svc.resolve({query:'监督',profile_id:'other'})).length,1);assert.equal(svc.isUsable(a.binding_id),true);});
