import { spawn } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,writeFileSync } from 'node:fs';
import { dirname,isAbsolute,join,relative } from 'node:path';
import type { ArtifactRef,RunIdentity } from '../protocol/types.js';
import { digest } from '../protocol/canonical.js';
import { openStore } from '../core/database.js';
import { BridgeError } from '../protocol/errors.js';
import { readProcessIdentity,runReceiptPath,type RunProof,type RunReceipt } from '../supervision/runs.js';
export interface RunWithReceiptOptions {root:string;argv:string[];source_commit:string;config_sha256:string;config_file?:string;artifacts?:string[];run_id?:string}
export interface RunHandle {identity:RunIdentity;completion:Promise<RunProof>}
function atomicReceipt(path:string,value:RunReceipt):void{const temp=path+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
export async function runWithReceipt(options:RunWithReceiptOptions):Promise<RunHandle>{
 if(!Array.isArray(options.argv) || !options.argv.length || options.argv.some(a=>typeof a!=='string' || a.includes('\0')) || !options.source_commit || !/^[a-f0-9]{64}$/.test(options.config_sha256))throw new BridgeError('invalid_run','Provide an argv array, source reference and config digest','Use --stdin JSON; commands are never evaluated as shell text');
 const root=realpathSync(options.root),store=openStore(root),project=store.project_id;store.close();
 if(options.config_file){const path=join(root,options.config_file),rel=relative(root,realpathSync(path));if(isAbsolute(options.config_file) || rel==='..' || rel.startsWith('../') || createHash('sha256').update(readFileSync(path)).digest('hex')!==options.config_sha256)throw new BridgeError('config_mismatch','Config does not match the exact run scope/digest','Verify the config before launching',3);}
 for(const path of options.artifacts??[])if(isAbsolute(path) || path.split(/[\\/]/).includes('..'))throw new BridgeError('artifact_scope_denied','Run artifact must be project-relative','Provide scoped artifact paths',3);
 const run_id=options.run_id??randomUUID(),path=runReceiptPath({root,run_id}),runs=dirname(dirname(path)),dir=dirname(path);mkdirSync(runs,{recursive:true,mode:0o700});if(realpathSync(runs)!==runs || lstatSync(runs).isSymbolicLink())throw new Error('Run store must be private and local');
 try{mkdirSync(dir,{mode:0o700});}catch{throw new BridgeError('run_exists','Run ID already has a launch intent; no job was restarted','Observe the original run or choose a genuinely new run',3);}
 const intent=openSync(join(dir,'launch-intent.json'),'wx',0o600);try{writeFileSync(intent,JSON.stringify({run_id,argv_sha256:digest(options.argv),source_commit:options.source_commit,config_sha256:options.config_sha256,launched_at:new Date().toISOString()}));fsyncSync(intent);}finally{closeSync(intent);}
 const stdout=openSync(join(dir,'stdout.log'),'wx',0o600),stderr=openSync(join(dir,'stderr.log'),'wx',0o600);
 const child=spawn(options.argv[0]!,options.argv.slice(1),{cwd:root,stdio:['ignore',stdout,stderr]});closeSync(stdout);closeSync(stderr);
 const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null;spawnError:boolean}>(resolve=>{child.once('error',()=>resolve({code:null,signal:null,spawnError:true}));child.once('exit',(code,signal)=>resolve({code,signal,spawnError:false}));});
 if(!child.pid){await exited;writeFileSync(join(dir,'launch-failure.json'),JSON.stringify({state:'failed',reason:'program_spawn_failed',run_id}),{flag:'wx',mode:0o600});throw new BridgeError('program_spawn_failed','Program launch failed; no job identity was claimed','Check the executable path before preparing a new run',6);}
 const native=await readProcessIdentity(child.pid).catch(()=>null);
 const identity:RunIdentity={run_id,pid:child.pid,started_at:native?.started_at??'unobserved-spawn:'+run_id,command_sha256:native?.command_sha256??digest({argv:options.argv,run_id}),root,source_commit:options.source_commit,config_sha256:options.config_sha256};
 const base:RunReceipt={schema_version:1,identity,status:'running',exit_code:null,signal:null,argv_sha256:digest(options.argv),artifacts:[]};atomicReceipt(path,base);
 const completion=exited.then(result=>{
  const artifacts:ArtifactRef[]=[];
  if(!result.spawnError)for(const relative_path of options.artifacts??[]){try{const full=join(root,relative_path),resolved=realpathSync(full),rel=relative(root,resolved);if(isAbsolute(rel) || rel==='..' || rel.startsWith('../') || lstatSync(full).isSymbolicLink())continue;artifacts.push({project_id:project,relative_path,sha256:createHash('sha256').update(readFileSync(full)).digest('hex')});}catch{/* Missing expected outputs remain absent; main acceptance must catch them. */}}
  const status=result.code===0?'completed':'failed',receipt:RunReceipt={...base,status,exit_code:result.code,signal:result.signal,artifacts};atomicReceipt(path,receipt);return {identity,status,exit_code:result.code,artifacts} satisfies RunProof;
 });
 return {identity,completion};
}
