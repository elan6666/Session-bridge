import type { Actor, AuthorityRef, TaskInput } from '../protocol/types.js';
import type { AuthorityCheck, AuthorityProvider } from './contract.js';
import { digest, sessionKey } from '../protocol/canonical.js';
export function scopeDigest(input:Omit<TaskInput,'authority'>):string {return digest(input);}
export class StandaloneWorkflow implements AuthorityProvider {
 async check(actor:Actor,ref:AuthorityRef,input:TaskInput):Promise<AuthorityCheck>{
  const {authority:_authority,...scope}=input;
  if(ref.workflow!=='standalone')return {state:'denied',evidence:null,reason:'Byte authority must use the Byte provider'};
  const granted=ref.owner_session_key===sessionKey(actor.session) && ref.scope_digest===scopeDigest(scope) && actor.scope.project_id===input.source.project_id && sessionKey(actor.session)===sessionKey(input.source);
  return {state:granted?'granted':'denied',evidence:granted?'standalone task scope checked':null,reason:granted?undefined:'Owner or scope digest mismatch'};
 }
}
