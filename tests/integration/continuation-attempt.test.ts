import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempRoot } from '../helpers/fixtures.js';

test('two_native_actions_and_a_restart_cannot_repeat_one_next_step',async t=>{
 const {root,cleanup}=tempRoot();t.after(cleanup);
 const script=`import{reserveContinuationAttempt}from ${JSON.stringify(pathToFileURL(resolve('dist/src/return/attempt.js')).href)};import{appendFileSync}from'node:fs';import{join}from'node:path';try{reserveContinuationAttempt(process.argv[1],process.argv[2],process.argv[3],{fixed:'step'});if(process.argv[4]==='crash')process.exit(7);appendFileSync(join(process.argv[1],'executed.txt'),'1');}catch(e){if(e.code==='continuation_already_attempted')process.exit(3);throw e;}`;
 const run=(task:string,action:string,mode='run')=>new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script,root,task,action,mode],{stdio:'ignore'});child.once('error',reject);child.once('exit',resolve);});
 const first=await Promise.all([run('one','action-a'),run('one','action-b')]);assert.deepEqual(first.sort(),[0,3]);assert.equal(readFileSync(join(root,'executed.txt'),'utf8'),'1');
 assert.equal(await run('one','new-id-after-restart'),3);assert.equal(readFileSync(join(root,'executed.txt'),'utf8'),'1');
 assert.equal(await run('unknown','committed-intent','crash'),7);assert.equal(await run('unknown','blind-retry'),3);assert.equal(readFileSync(join(root,'executed.txt'),'utf8'),'1');
});

test('an_action_id_collision_does_not_reserve_a_next_step_that_never_started',async t=>{
 const {root,cleanup}=tempRoot();t.after(cleanup);const {prepareActionAttempt}=await import('../../src/return/attempt.js');
 prepareActionAttempt(root,'task','used-by-verification','verification',{fixed:'verification'});
 assert.throws(()=>prepareActionAttempt(root,'task','used-by-verification','continuation',{fixed:'continuation'}),(error:unknown)=>(error as {code:string}).code==='action_id_conflict');
 assert.doesNotThrow(()=>prepareActionAttempt(root,'task','fresh-continuation-id','continuation',{fixed:'continuation'}));
});
