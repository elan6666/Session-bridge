import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../src/cli/main.js';
import { checkRuntime,skillCommand } from '../../src/cli/runtime.js';
test('missing_runtime_has_actionable_error',()=>{assert.throws(()=>checkRuntime('v22.0.0'),/Node.*24|24.*Node/i);});
test('non_tty_never_hangs',async()=>{let out='',err='';const code=await runCli([],{stdin:'',isTTY:false,stdout:s=>{out+=s;},stderr:s=>{err+=s;}});assert.equal(code,4);assert.match(out+err,/向导|stdin|交互|命令/);});
test('reported_skill_command_matches_host',()=>{assert.equal(skillCommand('codex'),'$sessionbridge-do');assert.equal(skillCommand('claude'),'/sessionbridge-do');assert.equal(skillCommand('pi'),'/skill:sessionbridge-do');assert.equal(skillCommand('hermes'),'/sessionbridge-do');assert.match(skillCommand('dsh'),/sessionbridge-do/);});
