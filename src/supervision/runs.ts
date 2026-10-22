import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,realpath,lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ArtifactRef,RunIdentity } from '../protocol/types.js';
import { digest } from '../protocol/canonical.js';
import { verifyArtifact } from '../core/artifacts.js';
const execute=promisify(execFile);
export interface RunProof {identity:RunIdentity;exit_code:number|null;status:'running'|'completed'|'failed'|'unknown';artifacts:ArtifactRef[];reason?:string}
export interface ProcessIdentity {started_at:string;command_sha256:string}
export interface RunReceipt {schema_version:1;identity:RunIdentity;status:'running'|'completed'|'failed';exit_code:number|null;signal:string|null;argv_sha256:string;artifacts:ArtifactRef[]}
export function runReceiptPath(identity:Pick<RunIdentity,'root'|'run_id'>):string{return join(identity.root,'.session-bridge','runs',digest(identity.run_id),'receipt.json');}
export async function readProcessIdentity(pid:number):Promise<ProcessIdentity|null>{
 if(!Number.isInteger(pid) || pid<=0)return null;
 try{
  if(process.platform==='linux'){const base='/proc/'+pid,stat=await readFile(base+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(fields[0]==='Z')return null;const boot=await readFile('/proc/sys/kernel/random/boot_id','utf8'),command=await readFile(base+'/cmdline');return {started_at:boot.trim()+':'+fields[19],command_sha256:createHash('sha256').update(command).digest('hex')};}
  if(process.platform==='darwin'){const result=await execute('ps',['-p',String(pid),'-ww','-o','lstart=','-o','command='],{timeout:5000,maxBuffer:1024*1024});const match=/^(.{24})\s+(.*)$/.exec(result.stdout.trimEnd());if(!match)return null;return {started_at:match[1]!.trim(),command_sha256:createHash('sha256').update(match[2]!).digest('hex')};}
  return null;
 }catch(error){if(['ENOENT','ESRCH',1].includes((error as {code:string|number}).code))return null;throw error;}
}
export async function observeRun(identity:RunIdentity,probe:(pid:number)=>Promise<ProcessIdentity|null>=readProcessIdentity):Promise<RunProof>{
 const unknown:RunProof={identity,exit_code:null,status:'unknown',artifacts:[]};
 try{
  const current=await probe(identity.pid);
  if(current && (current.started_at!==identity.started_at || current.command_sha256!==identity.command_sha256))return unknown;
  let receipt:RunReceipt|undefined;const path=runReceiptPath(identity);
  try{const info=await lstat(path);if(info.isSymbolicLink() || !info.isFile() || await realpath(path)!==path)return unknown;receipt=JSON.parse(await readFile(path,'utf8')) as RunReceipt;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return unknown;}
  if(receipt && (receipt.schema_version!==1 || digest(receipt.identity)!==digest(identity)))return unknown;
  if(current)return receipt && receipt.status!=='running'?unknown:{identity,exit_code:null,status:'running',artifacts:[]};
  if(receipt?.status==='running')return {...unknown,reason:'awaiting_owned_exit_receipt'};
  if(!receipt || !['completed','failed'].includes(receipt.status) || (receipt.status==='completed' && receipt.exit_code!==0) || (receipt.status==='failed' && receipt.exit_code===0))return unknown;
  const project=JSON.parse(await readFile(join(identity.root,'.session-bridge','project.json'),'utf8')) as {project_id:string};
  for(const artifact of receipt.artifacts)if(artifact.project_id!==project.project_id || !await verifyArtifact(identity.root,artifact))return unknown;
  return {identity,exit_code:receipt.exit_code,status:receipt.status,artifacts:receipt.artifacts};
 }catch{return unknown;}
}
