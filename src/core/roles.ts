import type { Actor,RoleAssignment,SessionIdentity } from '../protocol/types.js';
import { sessionKey } from '../protocol/canonical.js';
import { BridgeError } from '../protocol/errors.js';
import { appendEvent,transaction,type BridgeStore } from './database.js';
import { exactBinding,requireActor } from './tasks.js';
export class RoleService {
 constructor(private store:BridgeStore,private gate?:(actor:Actor)=>Promise<void>){}
 async assignRoles(actor:Actor,roles:{main:SessionIdentity;supervisor:SessionIdentity}):Promise<RoleAssignment>{
  requireActor(this.store,actor,'configure_roles');
  if(sessionKey(actor.session)!==sessionKey(roles.main))throw new BridgeError('scope_denied','Role setup must originate in this exact main session','Run the role request from the intended main conversation',3);
  if(sessionKey(roles.main)===sessionKey(roles.supervisor))throw new BridgeError('invalid_roles','Supervisor must be a separate session','Choose another connected session');
  await this.gate?.(actor);await exactBinding(this.store,roles.main);await exactBinding(this.store,roles.supervisor);
  return transaction(this.store,()=>{
   const result={...roles,updated_at:new Date().toISOString()};
   this.store.db.prepare('INSERT INTO role_assignments VALUES (?,?,?,?,?) ON CONFLICT(main_session_key) DO UPDATE SET supervisor_identity_json=excluded.supervisor_identity_json,updated_by_binding_id=excluded.updated_by_binding_id,updated_at=excluded.updated_at').run(sessionKey(roles.main),JSON.stringify(roles.main),JSON.stringify(roles.supervisor),actor.binding_id,result.updated_at);
   appendEvent(this.store,'roles_assigned',sessionKey(roles.main),{main:roles.main,supervisor:roles.supervisor});
   return result;
  });
 }
 get(actor:Actor):RoleAssignment|null {
  requireActor(this.store,actor,actor.scope.operations.includes('get_task_status')?'get_task_status':'configure_roles');
  const row=this.store.db.prepare('SELECT * FROM role_assignments WHERE main_session_key=?').get(sessionKey(actor.session));
  return row?{main:JSON.parse(String(row.main_identity_json)),supervisor:JSON.parse(String(row.supervisor_identity_json)),updated_at:String(row.updated_at)}:null;
 }
}
