import type { Actor } from '../protocol/types.js';
import type { ReturnService } from '../return/service.js';
export function returnToMain(service:ReturnService,actor:Actor,taskId:string){return service.returnToMain(actor,taskId);}
