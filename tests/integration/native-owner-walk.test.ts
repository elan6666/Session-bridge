import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BUNDLED_CODEX,HAS_BUNDLED_CODEX} from '../helpers/codex-lab.js';

test('native_connect_reaches_the_exact_codex_owner_through_a_nested_node_process',{skip:!HAS_BUNDLED_CODEX||!process.env.CODEX_THREAD_ID,timeout:15000},async()=>{
 const moduleUrl=pathToFileURL(resolve('dist/src/adapters/codex/connect.js')).href,child=`const{originalCodexOwner}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(await originalCodexOwner()));`;
 const parent=`process.title='node';const{execFile}=require('node:child_process');execFile(process.execPath,['--input-type=module','-e',${JSON.stringify(child)}],{encoding:'utf8'},(error,stdout,stderr)=>{process.stdout.write(stdout);process.stderr.write(stderr);process.exitCode=error?1:0;});`;
 const result=await promisify(execFile)(process.execPath,['-e',parent],{encoding:'utf8',timeout:12000}),owner=JSON.parse(result.stdout);assert.equal(owner.executable,realpathSync(BUNDLED_CODEX));assert.equal(Number.isInteger(owner.pid)&&owner.pid>1,true);assert.ok(owner.started_at);
});
