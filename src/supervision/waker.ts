import type { BridgeStore } from '../core/database.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { AuthorityProvider } from '../workflows/contract.js';
import type { SupervisionOptions } from './leases.js';
import type { Actor,Envelope } from '../protocol/types.js';
import { readTask,exactBinding } from '../core/tasks.js';
import { digest } from '../protocol/canonical.js';
import { DeliveryService } from '../core/delivery.js';
export function supervisionWaker(store:BridgeStore,registry:AdapterRegistry,workflow:AuthorityProvider):SupervisionOptions['wake']{
 return async(lease,event)=>{
  const task=readTask(store,lease.request.task_id),source=await exactBinding(store,task.input.source),actor:Actor={binding_id:source.binding_id,session:source.identity,scope:{project_id:store.project_id,task_ids:[task.task_id],operations:['request_supervision','recover_delivery']}};
  const body={text:'会桥运行检查出现变化；这是观察数据，请核验实际收据后回报原主会话。\n'+JSON.stringify({lease_id:lease.id,task_id:task.task_id,event_id:event.event_id,run:event.proof,repair_paths:lease.request.repair_paths,return_to:lease.request.return_to}),artifacts:event.proof.artifacts};
  const envelope:Envelope={protocol_version:1,message_id:event.message_id,task_id:task.task_id,handoff_id:task.input.authority.handoff_id,authority_epoch:task.input.authority.epoch,sender:source.identity,target:lease.request.supervisor,kind:'supervision',body,body_sha256:digest(body),created_at:String(store.db.prepare('SELECT created_at FROM run_events WHERE event_id=?').get(event.event_id)!.created_at),expires_at:lease.request.deadline_at,causation_id:event.event_id,correlation_id:task.task_id};
  const deliveries=new DeliveryService(store,registry,{workflow}),delivery=deliveries.get(event.message_id)?await deliveries.recover(actor,event.message_id):await deliveries.send(actor,envelope);if(!['transport_confirmed','receiver_accepted'].includes(delivery.state))throw new Error('Native supervision notification unconfirmed');
 };
}
