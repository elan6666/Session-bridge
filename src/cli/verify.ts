import type { Actor } from '../protocol/types.js';
import type { ReturnService,VerificationEvidence,ContinuationEvidence } from '../return/service.js';
export function verifyTask(service:ReturnService,actor:Actor,taskId:string,evidence:VerificationEvidence){return service.verifyTask(actor,taskId,evidence);}
export function recordMainContinuation(service:ReturnService,actor:Actor,taskId:string,evidence:ContinuationEvidence){return service.recordMainContinuation(actor,taskId,evidence);}
