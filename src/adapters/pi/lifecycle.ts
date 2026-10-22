import { randomUUID } from 'node:crypto';
import type { ExtensionAPI,ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Envelope } from '../../protocol/types.js';
import { PLUGIN_PREFIX,pluginWireText } from '../plugin-client.js';
import { parseEnvelope } from '../../protocol/schema.js';
export interface PiConnection {close():Promise<void>;publish(envelope:Envelope,state:'accepted'|'completed'):Promise<void>}
export interface PiRuntime {start(context:ExtensionContext,generation:string,deliver:(envelope:Envelope)=>Promise<void>):Promise<PiConnection|undefined>}
export function installPi(pi:ExtensionAPI,runtime:PiRuntime):void {
 let generation='',current:PiConnection|undefined,session='',pending=new Map<string,Envelope>();
 const shutdown=async()=>{generation=randomUUID();const old=current;current=undefined;session='';pending=new Map();await old?.close();};
 pi.on('session_shutdown',shutdown);
 pi.on('session_start',async(_event,ctx)=>{
  await shutdown();if(!ctx.isProjectTrusted())return;
  const ownGeneration=generation,nativeSession=ctx.sessionManager.getSessionId();session=nativeSession;
  const live=()=>generation===ownGeneration && session===nativeSession && ctx.sessionManager.getSessionId()===nativeSession;
  const connection=await runtime.start(ctx,ownGeneration,async envelope=>{
   if(!live())throw new Error('Stale native session generation');
   pending.set(envelope.message_id,envelope);
   pi.sendUserMessage(pluginWireText(envelope),{deliverAs:'followUp',expandPromptTemplates:false});
  });
  if(!connection)return;
  if(!live()){await connection.close();return;}current=connection;
 });
 pi.on('input',async(event,ctx)=>{
  if(!current || ctx.sessionManager.getSessionId()!==session || event.source!=='extension' || !event.text.startsWith(PLUGIN_PREFIX))return;
  try{const envelope=parseEnvelope(JSON.parse(event.text.slice(PLUGIN_PREFIX.length)));const expected=pending.get(envelope.message_id);if(!expected || pluginWireText(expected)!==event.text)return;await current.publish(envelope,'accepted');}catch{/* Unrelated native input is not bridge acceptance. */}
 });
 // Completion is reported by the task's explicit result, not inferred from arbitrary agent_end events.
}
