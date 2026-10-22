import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { initProject } from '../../src/cli/init.js';
import { openStore } from '../../src/core/database.js';
import { tempRoot } from '../helpers/fixtures.js';
const exec=promisify(execFile);
test('future_schema_is_not_downgraded',async t=>{const {root,cleanup}=tempRoot();t.after(cleanup);await initProject(root,{dryRun:false});const p=join(root,'.session-bridge','bridge.sqlite');const db=new DatabaseSync(p);db.exec("PRAGMA user_version=999; CREATE TABLE future(value TEXT); INSERT INTO future VALUES ('keep')");db.close();assert.throws(()=>openStore(root),/newer|future/i);const check=new DatabaseSync(p);assert.equal(check.prepare('PRAGMA user_version').get()?.user_version,999);assert.equal(check.prepare('SELECT value FROM future').get()?.value,'keep');check.close();});
test('independent_processes_share_unique_constraints',async t=>{const {root,cleanup}=tempRoot();t.after(cleanup);await initProject(root,{dryRun:false});const store=openStore(root);store.close();const script="import {openStore} from './dist/src/core/database.js';const s=openStore(process.argv[1]);s.db.prepare('INSERT OR IGNORE INTO leases(id,holder,expires_at) VALUES (?,?,?)').run('one',String(process.pid),'2099');s.close();";await Promise.all([exec(process.execPath,['--input-type=module','-e',script,root]),exec(process.execPath,['--input-type=module','-e',script,root])]);const check=openStore(root);t.after(()=>check.close());assert.equal(check.db.prepare('SELECT count(*) n FROM leases').get()?.n,1);assert.equal(check.db.prepare('PRAGMA busy_timeout').get()?.timeout,5000);});

test('sessions_cli_lists_connected_alias_without_endpoint',async t=>{const {root,cleanup}=tempRoot();t.after(cleanup);await initProject(root,{dryRun:false});const {BindingService,issueEnrollment}=await import('../../src/core/bindings.js');const {binding}=await import('../helpers/bindings.js');const store=openStore(root);const svc=new BindingService(store);const b=binding(store,{endpoint_ref:'PRIVATE_SENTINEL'});await svc.enroll(issueEnrollment(store),b);store.close();const result=await exec(process.execPath,['dist/src/cli/main.js','sessions','--project',root,'--query','监督','--json'],{timeout:5000});assert.equal(JSON.parse(result.stdout).sessions.length,1);assert.equal(result.stdout.includes('PRIVATE_SENTINEL'),false);});
