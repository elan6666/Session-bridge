import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryLab } from '../helpers/delivery-lab.js';
import { runDaemon } from '../../src/cli/daemon.js';
import { BridgeClient } from '../../src/transport/client.js';
import { issueSessionCapability } from '../../src/transport/auth.js';

test('native_supervision_tool_accepts_omitted_optional_fields_and_registers_the_exact_run',async t=>{
 const f=await deliveryLab(t),socket=join(f.root,'tool.sock'),server=await runDaemon(f.root,socket,f.registry);t.after(()=>server.close());
 const run={run_id:'native-tool-run',pid:process.pid,started_at:'test-own-process',command_sha256:'a'.repeat(64),root:f.root,source_commit:'test',config_sha256:'b'.repeat(64)};writeFileSync(join(f.root,'run.json'),JSON.stringify({identity:run}));
 const client=new BridgeClient({socketPath:socket,token:issueSessionCapability(f.store,f.actor)}),request_id=randomUUID();
 const result=await client.call(f.actor,'request_supervision',{request_id,task_id:f.task.task_id,run_file:'run.json',supervisor_query:'worker',interval_seconds:60,deadline_at:'2098-01-01T00:00:00Z',repair_paths:[]}) as {state:string;result:{request:{run:unknown}}};
 assert.equal(result.state,'executed');assert.deepEqual(result.result.request.run,run);assert.equal(f.store.db.prepare('SELECT count(*) n FROM supervision WHERE active=1').get()?.n,1);
});
