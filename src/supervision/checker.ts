import { randomUUID } from 'node:crypto';
import type { BridgeStore } from '../core/database.js';
import { transaction } from '../core/database.js';
export function acquireCheck(store:BridgeStore,id:string,now:Date):string|null{
 const holder=randomUUID();return transaction(store,()=>{const changed=store.db.prepare('INSERT INTO leases(id,holder,expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at WHERE leases.expires_at<=?').run('supervision:'+id,holder,new Date(now.getTime()+30000).toISOString(),now.toISOString()).changes;return changed===1?holder:null;});
}
export function releaseCheck(store:BridgeStore,id:string,holder:string):void{store.db.prepare('DELETE FROM leases WHERE id=? AND holder=?').run('supervision:'+id,holder);}
