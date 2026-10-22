import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyArtifact } from '../../src/core/artifacts.js';
import { initProject } from '../../src/cli/init.js';
import { tempRoot } from '../helpers/fixtures.js';
test('artifact_symlink_escape_refused',async t=>{const a=tempRoot(),b=tempRoot();t.after(a.cleanup);t.after(b.cleanup);const {project_id}=await initProject(a.root,{dryRun:false});writeFileSync(join(b.root,'secret'),'private');symlinkSync(join(b.root,'secret'),join(a.root,'escape'));const ref={project_id,relative_path:'escape',sha256:createHash('sha256').update('private').digest('hex')};assert.equal(await verifyArtifact(a.root,ref),false);assert.equal(await verifyArtifact(a.root,{...ref,relative_path:'../secret'}),false);writeFileSync(join(a.root,'good'),'private');assert.equal(await verifyArtifact(a.root,{...ref,relative_path:'good'}),true);assert.equal(await verifyArtifact(a.root,{...ref,relative_path:'good',sha256:'0'.repeat(64)}),false);});
