import { access, link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../protocol/errors.js';
export interface ProjectConfig {protocol_version:1;project_id:string}
export async function readProject(root:string):Promise<ProjectConfig>{
  const p=join(root,'.session-bridge','project.json');
  const data=JSON.parse(await readFile(p,'utf8')) as Partial<ProjectConfig>;
  if(data.protocol_version!==1 || typeof data.project_id!=='string' || !data.project_id)throw new BridgeError('invalid_project','Project config is incompatible','Use a compatible SessionBridge version');
  return data as ProjectConfig;
}
export async function initProject(root:string,options:{dryRun:boolean}):Promise<{project_id:string;created:boolean}> {
  const resolved=await realpath(root);
  if(!(await lstat(resolved)).isDirectory())throw new BridgeError('invalid_root','Project root must be a directory','Choose an existing writable directory');
  await access(resolved,constants.W_OK);
  const dir=join(resolved,'.session-bridge');
  try{const info=await lstat(dir);if(!info.isDirectory() || info.isSymbolicLink())throw new BridgeError('unsafe_state_dir','State directory must be a real directory','Choose a private local project directory');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try{return {...await readProject(resolved),created:false};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(options.dryRun)return {project_id:'dry-run',created:false};
  await mkdir(dir,{recursive:true,mode:0o700});
  const config:ProjectConfig={protocol_version:1,project_id:randomUUID()};
  const scratch=join(dir,`.init-${randomUUID()}.tmp`);
  await writeFile(scratch,JSON.stringify(config)+'\n',{mode:0o600,flag:'wx'});
  let created=false;
  try{await link(scratch,join(dir,'project.json'));created=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}finally{await unlink(scratch);}
  return {...await readProject(resolved),created};
}
