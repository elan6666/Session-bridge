import { dirname,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import type { DshPluginConfig } from '../../dist/src/adapters/dsh/extension.js';
// @ts-expect-error shipped JavaScript locator has no TypeScript declaration
import { locateCore } from './locate.mjs';
export const name='sessionbridge';
export const inject=['agents','sessionController','remoteAccess','sessions','tools','skills'];
export function apply(ctx:Context,config:DshPluginConfig):void {
 const directory=dirname(fileURLToPath(import.meta.url));
 // Register the packaged Skills using the host's own provider. Git-root discovery
 // otherwise misses a plugin installed in a narrower workspace subdirectory.
 const disposeSkills=ctx.skills.registerProvider(control=>new FileSystemSkillProvider(ctx,control,{providerName:'sessionbridge',includeDefaultRoots:false,customSkillDirs:[join(directory,'skills')],watch:false}));
 ctx.effect(()=>disposeSkills);
 ctx.effect(async()=>{const core=locateCore(directory),{installDsh}=await import(pathToFileURL(join(core,'dist/src/adapters/dsh/extension.js')).href),{sessionKey}=await import(pathToFileURL(join(core,'dist/src/protocol/canonical.js')).href);return installDsh(ctx,config,(envelope:import('../../dist/src/protocol/types.js').Envelope,text:string)=>createUserMessage({content:[{type:'text',text}],source:{kind:'sessionbridge',form:'relay',message_id:envelope.message_id,sender_session_key:sessionKey(envelope.sender)}}));},'sessionbridge-native');
}
