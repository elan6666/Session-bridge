import { readFile,realpath } from 'node:fs/promises';
import { isAbsolute,relative,resolve } from 'node:path';
import { createHash } from 'node:crypto';
export async function artifactBaseline(root:string,paths:string[]):Promise<Record<string,string|null>>{
 const result:Record<string,string|null>={};for(const path of paths){try{const full=await realpath(resolve(root,path)),rel=relative(root,full);if(isAbsolute(rel) || rel==='..' || rel.startsWith('../'))throw new Error('Outside project');result[path]=createHash('sha256').update(await readFile(full)).digest('hex');}catch{result[path]=null;}}return result;
}
export function withinPaths(path:string,scopes:string[]):boolean{return Boolean(path && !isAbsolute(path) && !path.split(/[\\/]/).includes('..') && !path.startsWith('.session-bridge/') && !path.startsWith('.git/') && scopes.some(scope=>scope==='.' || path===scope || path.startsWith(scope+'/')));}
