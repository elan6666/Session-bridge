import { existsSync,lstatSync,readFileSync,rmSync,writeFileSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { transaction,type BridgeStore } from './database.js';
import { privateDirectory } from './private-paths.js';
import { BridgeError } from '../protocol/errors.js';
export interface CoreEndpoint {address:string;pid:number;nonce:string}
export function projectEndpoint(root:string):CoreEndpoint|null{
 const path=join(root,'.session-bridge','core-endpoint.json');if(!existsSync(path))return null;const info=lstatSync(path);
 if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o077)!==0 || (process.getuid && info.uid!==process.getuid()))throw new BridgeError('unsafe_core_endpoint','项目内核地址文件不安全','重新运行 doctor 核对私有目录',3);
 const value=JSON.parse(readFileSync(path,'utf8'));if(typeof value.address!=='string' || !Number.isInteger(value.pid) || value.pid<=0 || typeof value.nonce!=='string')throw new Error('Invalid project core endpoint');return value;
}
export function processIsAlive(pid:number):boolean{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
// Reserve one project owner before touching a socket. A failed start leaves the
// previous private endpoint intact, so unknown files never lose their provenance.
export function reserveEndpoint(store:BridgeStore,address:string){
 const prior=projectEndpoint(store.root);if(prior && processIsAlive(prior.pid))throw new BridgeError('core_already_running','本项目已有存活的内核地址记录','使用已运行服务；如服务关闭异常请先核对原进程，不能启动第二个协调内核',3);
 privateDirectory(store.root,['.session-bridge']);const path=join(store.root,'.session-bridge','core-endpoint.json'),nonce=randomUUID(),holder=JSON.stringify({pid:process.pid,nonce}),temp=path+'.'+nonce+'.tmp';
 transaction(store,()=>{const row=store.db.prepare("SELECT holder FROM leases WHERE id='core-owner'").get();if(row){const pid=JSON.parse(String(row.holder)).pid;if(!Number.isInteger(pid) || pid<=0 || processIsAlive(pid))throw new BridgeError('core_already_running','本项目已有协调内核','使用原服务，不启动第二个服务进程',3);}store.db.prepare("INSERT INTO leases(id,holder,expires_at) VALUES ('core-owner',?,'9999-01-01T00:00:00Z') ON CONFLICT(id) DO UPDATE SET holder=excluded.holder").run(holder);});
 let released=false;
 const release=()=>{if(released)return;released=true;if(projectEndpoint(store.root)?.nonce===nonce)rmSync(path,{force:true});store.db.prepare("DELETE FROM leases WHERE id='core-owner' AND holder=?").run(holder);};
 return {previous:prior,publish:()=>{if(released || store.db.prepare("SELECT holder FROM leases WHERE id='core-owner'").get()?.holder!==holder)throw new Error('Core ownership changed before publication');try{writeFileSync(temp,JSON.stringify({address,pid:process.pid,nonce}),{mode:0o600,flag:'wx'});renameSync(temp,path);}catch(error){release();throw error;}return release;},release};
}
export function publishEndpoint(store:BridgeStore,address:string):()=>void{return reserveEndpoint(store,address).publish();}
