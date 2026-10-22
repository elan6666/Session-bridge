import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Actor, Clock, NativeContextProof, SessionIdentity } from '../protocol/types.js';
import { systemClock } from '../protocol/types.js';
import { nonempty, requestOperations, sessionSchema } from '../protocol/schema.js';
import { digest } from '../protocol/canonical.js';
import { BridgeError } from '../protocol/errors.js';
import { BindingService } from '../core/bindings.js';
import { transaction, type BridgeStore } from '../core/database.js';
export const actorSchema=z.strictObject({session:sessionSchema,binding_id:nonempty,scope:z.strictObject({project_id:nonempty,task_ids:z.array(nonempty),operations:z.array(nonempty)})});
function denied():never {throw new BridgeError('scope_denied','Session capability is invalid or out of scope','Reconnect the exact session in the intended project',3);}
export function issueSessionCapability(store:BridgeStore,input:Actor,clock:Clock=systemClock):string {
 const actor=actorSchema.parse(input),bindings=new BindingService(store,clock),b=bindings.get(actor.binding_id);
 if(!b || !bindings.isUsable(b.binding_id) || digest(b.identity)!==digest(actor.session) || actor.scope.project_id!==store.project_id)denied();
 const token=randomBytes(32).toString('hex');
 const expires=new Date(Math.min(Date.parse(b.expires_at),clock.now().getTime()+86_400_000)).toISOString();
 store.db.prepare('INSERT INTO session_capabilities(capability_hash,binding_id,actor_json,expires_at) VALUES (?,?,?,?)').run(digest(token),b.binding_id,JSON.stringify(actor),expires);
 return token;
}
export function authenticate(store:BridgeStore,token:string,claimed:Actor,method:string,params:unknown,clock:Clock=systemClock):Actor {
 if(typeof token!=='string' || token.length!==64)denied();
 const row=store.db.prepare('SELECT * FROM session_capabilities WHERE capability_hash=? AND revoked=0 AND expires_at>?').get(digest(token),clock.now().toISOString());
 if(!row)denied();
 const actor=actorSchema.parse(JSON.parse(String(row.actor_json))),bindings=new BindingService(store,clock),b=bindings.get(actor.binding_id);
 if(!b || !bindings.isUsable(b.binding_id) || digest(b.identity)!==digest(actor.session) || actor.scope.project_id!==store.project_id || digest(actor)!==digest(claimed))denied();
 let operation=method==='verify_context'?'context':method;
 if(method==='request'){const intent=params && typeof params==='object' && 'operation' in params?String(params.operation):'';operation=requestOperations[intent as keyof typeof requestOperations]??'';}
 if(!actor.scope.operations.includes(operation))denied();
 if(params && typeof params==='object' && 'task_id' in params){const task=(params as {task_id:unknown}).task_id;if(typeof task!=='string' || (!actor.scope.task_ids.includes('*') && !actor.scope.task_ids.includes(task)))denied();}
 return actor;
}
export function createContextProof(store:BridgeStore,token:string,actor:Actor,clock:Clock=systemClock):NativeContextProof {
 authenticate(store,token,actor,'context',{},clock);
 const proof:NativeContextProof={binding_id:actor.binding_id,challenge_id:randomBytes(24).toString('hex'),response:randomBytes(32).toString('hex'),identity:actor.session,expires_at:new Date(clock.now().getTime()+30_000).toISOString()};
 store.db.prepare('INSERT INTO context_challenges(challenge_id,binding_id,capability_hash,identity_sha256,response_sha256,expires_at) VALUES (?,?,?,?,?,?)').run(proof.challenge_id,proof.binding_id,digest(token),digest(proof.identity),digest(proof.response),proof.expires_at);
 return proof;
}
export class ContextAuth {
 constructor(private store:BridgeStore,private clock:Clock=systemClock){}
 async verify(proof:NativeContextProof):Promise<SessionIdentity>{
  if(!proof || typeof proof.response!=='string' || typeof proof.challenge_id!=='string')denied();
  return transaction(this.store,()=>{
   const row=this.store.db.prepare('SELECT * FROM context_challenges WHERE challenge_id=? AND used=0 AND expires_at>?').get(proof.challenge_id,this.clock.now().toISOString());
   if(!row || row.binding_id!==proof.binding_id || row.identity_sha256!==digest(proof.identity) || row.response_sha256!==digest(proof.response) || row.expires_at!==proof.expires_at)denied();
   const cap=this.store.db.prepare('SELECT * FROM session_capabilities WHERE capability_hash=? AND revoked=0 AND expires_at>?').get(String(row.capability_hash),this.clock.now().toISOString());
   const bindings=new BindingService(this.store,this.clock),b=bindings.get(proof.binding_id);
   if(!cap || !b || !bindings.isUsable(b.binding_id) || digest(b.identity)!==digest(proof.identity))denied();
   this.store.db.prepare('UPDATE context_challenges SET used=1 WHERE challenge_id=?').run(proof.challenge_id);
   return b.identity;
  });
 }
}
