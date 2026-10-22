import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { initProject } from '../../src/cli/init.js';
import { tempRoot } from '../helpers/fixtures.js';
test('init_is_idempotent',async t=>{const {root,cleanup}=tempRoot();t.after(cleanup);const first=await initProject(root,{dryRun:false});const second=await initProject(root,{dryRun:false});assert.equal(second.project_id,first.project_id);assert.equal(first.created,true);assert.equal(second.created,false);assert.deepEqual(readdirSync(root),['.session-bridge']);});
test('dry_run_changes_nothing',async t=>{const {root,cleanup}=tempRoot();t.after(cleanup);const before=readdirSync(root);const preview=await initProject(root,{dryRun:true});assert.deepEqual(readdirSync(root),before);assert.equal(preview.created,false);});
