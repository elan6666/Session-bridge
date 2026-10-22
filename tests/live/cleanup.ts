import { openStore } from '../../src/core/database.js';
import { readLiveMap,type LiveOptions } from './common/options.js';
export interface CleanupReceipt {run_id:string;pending_supervision:number;system_schedulers_created:false;jobs_killed:0;native_apps_stopped:0;note:string}
// Read-only audit. Native profile/controller owners close only their own resources.
export async function cleanupOwnedResources(runId:string,options:LiveOptions):Promise<CleanupReceipt>{const map=await readLiveMap(options),store=openStore(map.project_root);try{return {run_id:runId,pending_supervision:Number(store.db.prepare('SELECT count(*) n FROM supervision WHERE active=1').get()!.n),system_schedulers_created:false,jobs_killed:0,native_apps_stopped:0,note:'No broad process matching, native app shutdown, or scheduler mutation. Controller cleanup receipts must be checked separately.'};}finally{store.close();}}
