import { lstat,unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { BridgeError } from '../protocol/errors.js';
import { processIsAlive,type CoreEndpoint } from './endpoint.js';
async function refused(address:string):Promise<boolean>{return new Promise(resolve=>{const peer=createConnection(address);let done=false;const finish=(value:boolean)=>{if(done)return;done=true;clearTimeout(timer);peer.destroy();resolve(value);};const timer=setTimeout(()=>finish(false),500);peer.once('connect',()=>finish(false));peer.once('error',error=>finish((error as NodeJS.ErrnoException).code==='ECONNREFUSED'));});}
// Called only after the daemon holds the project's core-owner reservation.
export async function reclaimStaleCoreSocket(address:string,prior:CoreEndpoint|null):Promise<void>{
 let info;try{info=await lstat(address);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const denied=()=>new BridgeError('daemon_exists','Socket ownership or shutdown is not proven','Use the running daemon; inspect the exact private endpoint before removing any stale socket',3);
 if(!prior || prior.address!==address || processIsAlive(prior.pid) || !info.isSocket() || info.isSymbolicLink() || (info.mode&0o077)!==0 || (process.getuid && info.uid!==process.getuid()))throw denied();
 const parent=await lstat(dirname(address));if(!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode&0o077)!==0 || (process.getuid && parent.uid!==process.getuid()))throw denied();
 if(!await refused(address) || processIsAlive(prior.pid))throw denied();
 const current=await lstat(address),currentParent=await lstat(dirname(address));if(current.ino!==info.ino || current.dev!==info.dev || !current.isSocket() || currentParent.ino!==parent.ino || currentParent.dev!==parent.dev || currentParent.isSymbolicLink())throw denied();
 await unlink(address);
}
