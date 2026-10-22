import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Actor, BindingRecord, Clock, EnrollmentPrincipal, SessionSelector } from '../protocol/types.js';
import type { BridgeStore } from './database.js';
import { systemClock } from '../protocol/types.js';
import { digest, sessionKey } from '../protocol/canonical.js';
import { nonempty, sessionSchema, timestamp } from '../protocol/schema.js';
import { BridgeError } from '../protocol/errors.js';
import { transaction } from './database.js';
const bindingSchema=z.strictObject({binding_id:nonempty,identity:sessionSchema,alias:nonempty,mode:z.enum(['native','attached','hot_attached','managed','manual']),capabilities:z.array(z.strictObject({name:nonempty,supported:z.boolean(),evidence:z.string().nullable(),constraints:z.array(z.string())})),endpoint_ref:nonempty,expires_at:timestamp,active:z.boolean()});
export function issueEnrollment(store:BridgeStore,clock:Clock=systemClock):EnrollmentPrincipal{
 const principal:EnrollmentPrincipal={kind:'local_setup',project_id:store.project_id,capability_ref:randomBytes(32).toString('hex'),expires_at:new Date(clock.now().getTime()+300_000).toISOString()};
 store.db.prepare('INSERT INTO setup_capabilities(capability_hash,project_id,expires_at) VALUES (?,?,?)').run(digest(principal.capability_ref),principal.project_id,principal.expires_at);return principal;
}
function fromRow(row:Record<string,unknown>):BindingRecord{return {binding_id:String(row.binding_id),identity:JSON.parse(String(row.identity_json)),alias:String(row.alias),mode:row.mode as BindingRecord['mode'],capabilities:JSON.parse(String(row.capabilities_json)),endpoint_ref:String(row.endpoint_ref),expires_at:String(row.expires_at),active:Boolean(row.active)};}
export class BindingService {
 constructor(private store:BridgeStore,private clock:Clock=systemClock){}
 async enroll(principal:EnrollmentPrincipal,input:BindingRecord,guard?:()=>void):Promise<BindingRecord>{
   const record=bindingSchema.parse(input);
   if(principal.kind!=='local_setup' || principal.project_id!==this.store.project_id || record.identity.project_id!==this.store.project_id)throw new BridgeError('scope_denied','Enrollment project mismatch','Connect inside the intended project',3);
   if(Date.parse(record.expires_at)<=this.clock.now().getTime() || !record.active)throw new BridgeError('expired_binding','Binding is expired or inactive','Reconnect the native session',3);
   return transaction(this.store,()=>{
    guard?.();
    const consumed=this.store.db.prepare('UPDATE setup_capabilities SET consumed=1 WHERE capability_hash=? AND project_id=? AND consumed=0 AND expires_at>?').run(digest(principal.capability_ref),this.store.project_id,this.clock.now().toISOString());
    if(consumed.changes!==1)throw new BridgeError('invalid_setup','Setup capability is expired, used or unknown','Run connect again',3);
    const {runtime_generation:_generation,...base}=record.identity;const nativeKey=digest(base);
    this.store.db.prepare('UPDATE bindings SET active=0 WHERE native_key=? AND active=1').run(nativeKey);
    this.store.db.prepare('INSERT INTO bindings VALUES (?,?,?,?,?,?,?,?,?,?)').run(record.binding_id,nativeKey,sessionKey(record.identity),JSON.stringify(record.identity),record.alias,record.mode,JSON.stringify(record.capabilities),record.endpoint_ref,record.expires_at,1);
    return record;
   });
 }
 get(id:string):BindingRecord|null{const row=this.store.db.prepare('SELECT * FROM bindings WHERE binding_id=?').get(id);return row?fromRow(row):null;}
 isUsable(id:string):boolean{const b=this.get(id);return Boolean(b?.active && Date.parse(b.expires_at)>this.clock.now().getTime());}
 async resolve(selector:SessionSelector):Promise<BindingRecord[]>{
  const rows=this.store.db.prepare('SELECT * FROM bindings WHERE active=1 AND expires_at>? ORDER BY alias,binding_id').all(this.clock.now().toISOString());
  return rows.map(fromRow).filter(b=>b.identity.project_id===this.store.project_id && (!selector.project_id || selector.project_id===b.identity.project_id) && (!selector.harness || b.identity.harness===selector.harness) && (!selector.profile_id || b.identity.profile_id===selector.profile_id) && (b.alias.toLocaleLowerCase().includes(selector.query.toLocaleLowerCase()) || b.binding_id===selector.query));
 }
 async revoke(actor:Actor,bindingId:string):Promise<void>{
  if(actor.scope.project_id!==this.store.project_id || !this.isUsable(actor.binding_id) || sessionKey(this.get(actor.binding_id)!.identity)!==sessionKey(actor.session) || (bindingId!==actor.binding_id && !actor.scope.operations.includes('manage_bindings')))throw new BridgeError('scope_denied','Binding cannot revoke this session','Use the owning connected session',3);
  this.store.db.prepare('UPDATE bindings SET active=0 WHERE binding_id=?').run(bindingId);
 }
}
