import { readFile,realpath,stat } from 'node:fs/promises';
import { resolve,relative,isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { ArtifactRef } from '../protocol/types.js';
import { BridgeError } from '../protocol/errors.js';
export async function scopedFile(root:string,path:string,maxBytes=1024*1024):Promise<Buffer>{
 const base=await realpath(root),target=await realpath(resolve(base,path)),rel=relative(base,target),info=await stat(target);
 if(isAbsolute(path) || !rel || rel==='..' || rel.startsWith('../') || !info.isFile() || info.size>maxBytes)throw new BridgeError('file_scope_denied','文件超出当前项目或读取大小限制','提供项目内的相对路径',3);
 return readFile(target);
}
export async function artifactRefs(root:string,project_id:string,paths:string[]):Promise<ArtifactRef[]>{return Promise.all(paths.map(async relative_path=>({project_id,relative_path,sha256:createHash('sha256').update(await scopedFile(root,relative_path,64*1024*1024)).digest('hex')})));}
