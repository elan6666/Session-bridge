import { existsSync,lstatSync,mkdirSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
export function privateDirectory(root:string,parts:string[]):string{
 let path=realpathSync(root);
 for(const part of parts){if(!part || part==='.' || part==='..' || /[\\/]/.test(part))throw new Error('Invalid private directory component');path=join(path,part);if(!existsSync(path))mkdirSync(path,{mode:0o700});const info=lstatSync(path);if(info.isSymbolicLink() || !info.isDirectory() || realpathSync(path)!==path || (info.mode&0o077)!==0 || (process.getuid && info.uid!==process.getuid()))throw new Error('Private state directory is not owned, local and mode 0700');}
 return path;
}
