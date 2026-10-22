import type { Adapter } from '../contract.js';
import type { RegisteredHelperClient } from './inbox.js';
import { sessionKey } from '../../protocol/canonical.js';
import type { Envelope } from '../../protocol/types.js';
export function createClaudeAdapter({helper}:{helper:RegisteredHelperClient}):Adapter {
 const select=async(envelope:Envelope)=>(await helper.list()).find(b=>b.active && Date.parse(b.expires_at)>Date.now() && sessionKey(b.identity)===sessionKey(envelope.target));
 return {
  probe:async()=>({harness:'claude',version:'2.1.306',modes:{attached:{supported:true,evidence:'claude-2.1.306-native-probe',constraints:['Requires native SessionStart child','Native permission policy applies','Full attached acceptance pending']}},capabilities:[]}),
  discover:()=>helper.list(),
  enroll:async context=>{const binding=(await helper.list()).find(b=>b.binding_id===context.native_proof.binding_id && sessionKey(b.identity)===sessionKey(context.native_proof.identity));if(!binding)throw new Error('Connect from the native Claude child first');return binding;},
  deliver:async envelope=>{const b=await select(envelope);return b?helper.call(b.binding_id,'deliver',envelope):{state:'refused',reason:'Native Claude helper is not bound to this exact session'};},
  reconcile:async envelope=>{const b=await select(envelope);return b?helper.call(b.binding_id,'reconcile',envelope):[];},
  observe:async function*(_binding,signal){if(signal.aborted)return;/* No lifecycle polling at adapter factory time. Explicit reconciliation is authoritative. */},
  disconnect:async id=>{await helper.call(id,'disconnect',null);}
 };
}
