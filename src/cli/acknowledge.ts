import type { Actor } from '../protocol/types.js';
import type { ReturnService } from '../return/service.js';
export function acknowledgeTask(service:ReturnService,actor:Actor,taskId:string){return service.acknowledgeTask(actor,taskId);}
