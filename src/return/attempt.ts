import { writeFileSync,openSync,fsyncSync,closeSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { privateDirectory } from '../core/private-paths.js';
import { digest } from '../protocol/canonical.js';
import { BridgeError } from '../protocol/errors.js';

export function reserveContinuationAttempt(root:string,taskId:string,actionId:string,input:unknown):void {
 const directory=privateDirectory(root,['.session-bridge','continuation-attempts']);
 try {
  const fd=openSync(join(directory,digest(taskId)+'.json'),'wx',0o600);
  try{writeFileSync(fd,JSON.stringify({task_id:taskId,action_id:actionId,input_sha256:digest(input),created_at:new Date().toISOString()}));fsyncSync(fd);}finally{closeSync(fd);}
  for(const path of [directory,dirname(directory)]){const dir=openSync(path,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
 }
 catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new BridgeError('continuation_already_attempted','This task already has a durable next-action attempt','Reconcile its exact receipt; a new action ID must not rerun uncertain work',3);throw error;}
}

export function prepareActionAttempt(root:string,taskId:string,actionId:string,purpose:'verification'|'continuation',intent:unknown):void {
 const directory=privateDirectory(root,['.session-bridge','actions',digest(actionId)]);
 try{writeFileSync(join(directory,'intent.json'),JSON.stringify(intent),{flag:'wx',mode:0o600});}
 catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new BridgeError('action_id_conflict','Action ID already belongs to an earlier native action','Use a fresh action ID; no new command was executed',3);throw error;}
 if(purpose==='continuation')reserveContinuationAttempt(root,taskId,actionId,intent);
}
