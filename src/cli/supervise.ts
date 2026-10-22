import { setTimeout as delay } from 'node:timers/promises';
import type { RunIdentity } from '../protocol/types.js';
import { observeRun,type RunProof } from '../supervision/runs.js';
import type { Actor } from '../protocol/types.js';
import type { SupervisionRequest,SupervisionService } from '../supervision/leases.js';
export function supervise(service:SupervisionService,actor:Actor,request:SupervisionRequest){return service.armSupervision(actor,request);}
export async function watchRun(identity:RunIdentity,options:{timeoutMs:number;pollMs?:number;signal?:AbortSignal}):Promise<RunProof>{
 if(!Number.isFinite(options.timeoutMs) || options.timeoutMs<=0 || options.timeoutMs>3600000)throw new Error('watch requires a bounded positive timeout');const deadline=Date.now()+options.timeoutMs;
 let result=await observeRun(identity);
 while(result.status==='running' && Date.now()<deadline && !options.signal?.aborted){await delay(Math.min(options.pollMs??250,Math.max(1,deadline-Date.now())),undefined,{signal:options.signal}).catch(()=>{});if(options.signal?.aborted)break;result=await observeRun(identity);}
 return result;
}
