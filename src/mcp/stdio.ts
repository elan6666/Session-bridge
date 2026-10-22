import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Actor } from '../protocol/types.js';
import { sessionKey } from '../protocol/canonical.js';
import { BridgeError } from '../protocol/errors.js';
import { BridgeClient } from '../transport/client.js';
import { loadConnection } from '../cli/context.js';
import { createMcpServer } from './server.js';
export async function startMcp(options:{harness:string;argv:string[]}):Promise<void>{
 let root=process.cwd();for(let i=0;i<options.argv.length;i++){if(options.argv[i]==='--project' && options.argv[i+1])root=resolve(options.argv[++i]!);else throw new Error('Use --project PATH');}
 const current=async()=>{
  if(options.harness==='codex')throw new BridgeError('shared_mcp_source_unavailable','Codex 共享 MCP 进程没有可信的当前聊天来源','在原会话使用会桥 Skill/CLI；不会借用另一个会话的身份',3);
  return loadConnection(process.env,root,options.harness);
 };
 class DynamicClient extends BridgeClient {constructor(){super({socketPath:'unbound',token:''});}override async call(actor:Actor,method:string,params:unknown):Promise<unknown>{const c=await current();if(c.actor.binding_id!==actor.binding_id || sessionKey(c.actor.session)!==sessionKey(actor.session))throw new BridgeError('source_changed','Native session changed during the call','Retry from the exact current connected session',3);return new BridgeClient(c).call(actor,method,params);}}
 const server=createMcpServer({client:new DynamicClient(),getActor:async()=>(await current()).actor});await server.connect(new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:65536}));
}
