import type { Actor } from '../protocol/types.js';
import type { ReturnService,TaskResult } from '../return/service.js';
export function reportResult(service:ReturnService,actor:Actor,taskId:string,result:TaskResult){return service.reportResult(actor,taskId,result);}
