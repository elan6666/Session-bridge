import type { Actor, AuthorityRef, TaskInput } from '../protocol/types.js';
export interface AuthorityCheck {state:'granted'|'denied'|'unknown';evidence:string|null;reason?:string}
export interface AuthorityProvider {check(actor:Actor,ref:AuthorityRef,scope:TaskInput):Promise<AuthorityCheck>;authorizeDelegation?(actor:Actor,ref:AuthorityRef,scope:TaskInput):Promise<AuthorityCheck>;reconcileHandoff?(ref:AuthorityRef):Promise<AuthorityCheck>}
