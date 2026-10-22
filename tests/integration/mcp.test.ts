import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { startServer } from '../../src/transport/server.js';
import { BridgeClient } from '../../src/transport/client.js';
import { issueSessionCapability } from '../../src/transport/auth.js';
import { BindingService } from '../../src/core/bindings.js';
import { deliveryLab } from '../helpers/delivery-lab.js';
import { join } from 'node:path';
import { mkdtempSync,rmSync } from 'node:fs';
test('mcp_and_cli_share_scope',async t=>{
 const f=await deliveryLab(t),dir=mkdtempSync('/tmp/sb-mcp-'),actor={...f.actor,scope:{...f.actor.scope,operations:[...f.actor.scope.operations,'context','sessions']}},token=issueSessionCapability(f.store,actor),server=await startServer({root:f.root,socketPath:join(dir,'core.sock')});const bridge=new BridgeClient({socketPath:server.address,token});let actorReads=0;const mcp=createMcpServer({client:bridge,getActor:()=>{actorReads++;return actor;}}),client=new Client({name:'scope-test',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await mcp.connect(st);await client.connect(ct);
 t.after(async()=>{await client.close();await mcp.close();await server.close();rmSync(dir,{recursive:true,force:true});});
 const listed=await client.listTools();assert.equal(listed.tools.length,10);const okay=await client.callTool({name:'list_sessions',arguments:{query:''}});assert.notEqual(okay.isError,true);await new BindingService(f.store).revoke(actor,actor.binding_id);await assert.rejects(()=>bridge.call(actor,'sessions',{}));const denied=await client.callTool({name:'list_sessions',arguments:{query:''}});assert.equal(denied.isError,true);assert.equal(actorReads,2);
});
