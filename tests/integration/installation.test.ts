import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,readdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { planInstall } from '../../src/install/plan.js';
import { applyInstall } from '../../src/install/apply.js';
import { removeInstall } from '../../src/install/remove.js';
function root(t:{after:(fn:()=>void)=>void}){const dir=mkdtempSync('/tmp/sb-inst-');t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('install_dry_run_changes_nothing',async t=>{const dir=root(t),before=readdirSync(dir);const plan=await planInstall({harness:'claude',scope:'project',targetRoot:dir});assert.deepEqual(readdirSync(dir),before);assert.ok(plan.files.length>0);assert.ok(plan.next_steps.length>0);});
test('uninstall_preserves_user_edits',async t=>{const dir=root(t);writeFileSync(join(dir,'.mcp.json'),JSON.stringify({mcpServers:{existing:{command:'existing'}},provider:{model:'keep-me'}}));const plan=await planInstall({harness:'claude',scope:'project',targetRoot:dir}),receipt=await applyInstall(plan);assert.equal(receipt.state,'installed');const config=JSON.parse(readFileSync(join(dir,'.mcp.json'),'utf8'));assert.ok(config.mcpServers.sessionbridge);config.userAddition='preserve';writeFileSync(join(dir,'.mcp.json'),JSON.stringify(config));const file=receipt.owned_files[0]!;writeFileSync(file.path,readFileSync(file.path,'utf8')+'\nuser edit');const removed=await removeInstall(receipt);const current=JSON.parse(readFileSync(join(dir,'.mcp.json'),'utf8'));assert.equal(current.userAddition,'preserve');assert.equal(current.provider.model,'keep-me');assert.equal(current.mcpServers.existing.command,'existing');assert.equal(current.mcpServers.sessionbridge,undefined);assert.ok(removed.preserved.includes(file.path));});
test('repeat_install_does_not_lose_file_or_config_ownership',async t=>{const dir=root(t);const first=await applyInstall(await planInstall({harness:'claude',scope:'project',targetRoot:dir}));const repeated=await applyInstall(await planInstall({harness:'claude',scope:'project',targetRoot:dir}));assert.equal(repeated.state,'installed');assert.equal(repeated.config_owned,true);assert.ok(repeated.owned_files.length>=first.owned_files.length);await removeInstall(repeated);const configPath=join(dir,'.mcp.json');const {existsSync}=await import('node:fs');assert.equal(existsSync(configPath),false);});

test('uninstall_one_harness_keeps_shared_skills_for_other_installation',async t=>{
 const root=mkdtempSync('/tmp/sb-shared-install-');t.after(()=>rmSync(root,{recursive:true,force:true}));
 const codex=await applyInstall(await planInstall({harness:'codex',scope:'project',targetRoot:root}));
 const pi=await applyInstall(await planInstall({harness:'pi',scope:'project',targetRoot:root}));
 const skill=join(root,'.agents/skills/sessionbridge-do/SKILL.md');await removeInstall(codex);assert.equal(existsSync(skill),true);
 await removeInstall(pi);assert.equal(existsSync(skill),false);
});
