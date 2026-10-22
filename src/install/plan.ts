import { existsSync,lstatSync,readFileSync,readdirSync,realpathSync } from 'node:fs';
import { dirname,isAbsolute,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BridgeError } from '../protocol/errors.js';
import { digest } from '../protocol/canonical.js';
import { skillCommand } from '../cli/runtime.js';
export const HARNESSES=['codex','claude','pi','hermes','dsh'] as const;
export const SKILLS=['sessionbridge-do','session-bridge-delegate','session-bridge-supervise','session-bridge-return'];
export interface InstallFile {path:string;content:string;before_sha256:string|null}
export interface InstallPlan {harness:string;scope:'project'|'user';targetRoot:string;packageRoot:string;files:InstallFile[];config:{path:string;key:string;value:unknown;before_sha256:string|null}|null;next_steps:string[];conflicts:string[];previous:{receipt_file:string;owned_files:{path:string;sha256:string}[];config_owned:boolean;config_value_sha256:string|null}|null}
export function bytesHash(text:string|Buffer):string{return createHash('sha256').update(text).digest('hex');}
export function packageRoot():string{let dir=dirname(fileURLToPath(import.meta.url));for(let i=0;i<6;i++){const path=join(dir,'package.json');if(existsSync(path) && JSON.parse(readFileSync(path,'utf8')).name==='@sessionbridge/local')return realpathSync(dir);dir=dirname(dir);}throw new Error('SessionBridge package root is unavailable');}
export function installLocations(root:string,harness:string,scope:'project'|'user'):{plugin:string;skills:string}{
 const plugin=harness==='pi'?join(root,scope==='user'?'.pi/agent/extensions/sessionbridge':'.pi/extensions/sessionbridge'):harness==='hermes' && scope==='user'?join(root,'.hermes/plugins/sessionbridge'):join(root,'.session-bridge-plugins',harness);
 const skills=harness==='claude'?join(root,'.claude/skills'):harness==='hermes'?join(root,'.hermes/skills'):join(root,'.agents/skills');return {plugin,skills};
}
export function safeInstallPath(root:string,path:string):boolean{const rel=relative(root,path);if(!rel || rel==='..' || rel.startsWith('../') || isAbsolute(rel))return false;let current=path;while(!existsSync(current)){const parent=dirname(current);if(parent===current)return false;current=parent;}const actual=realpathSync(current),base=relative(root,actual);return !isAbsolute(base) && base!=='..' && !base.startsWith('../') && !lstatSync(current).isSymbolicLink();}
export function readJsonConfig(path:string):Record<string,unknown>{if(!existsSync(path))return {};if(lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())throw new Error('Config must be a regular file');const value=JSON.parse(readFileSync(path,'utf8'));if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Config must be a JSON object');return value;}
export function entryAt(value:Record<string,unknown>,key:string):unknown{const entries=value[key];if(entries===undefined)return undefined;if(!entries || typeof entries!=='object' || Array.isArray(entries))throw new Error('MCP config entry map must be an object');return (entries as Record<string,unknown>).sessionbridge;}
export async function planInstall(options:{harness:string;scope:'project'|'user';targetRoot:string}):Promise<InstallPlan>{
 if(!HARNESSES.includes(options.harness as typeof HARNESSES[number]) || !['project','user'].includes(options.scope))throw new BridgeError('install_target_invalid','请选择受支持的应用和 project/user 安装范围','运行 install --harness NAME --scope project --project PATH',4);
 const root=realpathSync(options.targetRoot),core=packageRoot(),locations=installLocations(root,options.harness,options.scope),files:InstallFile[]=[],conflicts:string[]=[];
 let previous:InstallPlan['previous']=null;const marker=join(root,'.session-bridge-install',options.harness+'-'+options.scope+'.json');if(existsSync(marker)){const pointer=JSON.parse(readFileSync(marker,'utf8')) as {receipt_file:string};if(safeInstallPath(root,pointer.receipt_file) && pointer.receipt_file.startsWith(join(root,'.session-bridge-install')+'/') && existsSync(pointer.receipt_file)){const prior=JSON.parse(readFileSync(pointer.receipt_file,'utf8'));if(prior.state==='installed' && prior.plan.harness===options.harness && prior.plan.scope===options.scope && prior.plan.targetRoot===root)previous={receipt_file:pointer.receipt_file,owned_files:prior.owned_files,config_owned:prior.config_owned,config_value_sha256:prior.plan.config?digest(prior.plan.config.value):null};}}
 const add=(path:string,content:string)=>{if(!safeInstallPath(root,path))throw new BridgeError('unsafe_install_path','安装目标链接指向范围之外','选择普通项目目录；不会跟随链接修改全局配置',3);const before=existsSync(path)?bytesHash(readFileSync(path)):null;files.push({path,content,before_sha256:before});};
 const tree=(source:string,dest:string)=>{for(const entry of readdirSync(source,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='__pycache__' || entry.name.endsWith('.pyc') || entry.name==='.sessionbridge-runtime.json')continue;const path=join(source,entry.name),target=join(dest,entry.name);if(entry.isSymbolicLink())throw new Error('Package payload contains an unexpected symlink');if(entry.isDirectory())tree(path,target);else if(entry.isFile())add(target,readFileSync(path,'utf8'));}};
 tree(join(core,'plugins',options.harness),locations.plugin);
 for(const name of SKILLS)tree(join(core,'skills',name),join(locations.skills,name));
 add(join(locations.plugin,'.sessionbridge-runtime.json'),JSON.stringify({protocol_version:1,core_root:core,node_bin:process.execPath},null,2)+'\n');
 let config:InstallPlan['config']=null;
 if(options.harness==='claude'){const path=join(root,'.mcp.json');if(!safeInstallPath(root,path))throw new Error('Unsafe project MCP config');const current=readJsonConfig(path),prior=entryAt(current,'mcpServers'),value={command:process.execPath,args:[join(locations.plugin,'scripts/mcp.mjs'),'--project',root]};config={path,key:'mcpServers',value,before_sha256:prior===undefined?null:digest(prior)};if(prior!==undefined && digest(prior)!==digest(value) && !(previous?.config_owned && previous.config_value_sha256===digest(prior)))conflicts.push(path+':mcpServers.sessionbridge');}
 for(const file of files)if(file.before_sha256!==null && file.before_sha256!==bytesHash(file.content) && !previous?.owned_files.some(old=>old.path===file.path && old.sha256===file.before_sha256))conflicts.push(file.path);
 return {harness:options.harness,scope:options.scope,targetRoot:root,packageRoot:core,files,config,previous,next_steps:[`原生 Skill 用法：${skillCommand(options.harness)}`,options.harness==='claude'?`在专用或空闲会话显式使用 claude --plugin-dir ${JSON.stringify(locations.plugin)}；MCP/Hook 许可由原生应用确认。`:options.harness==='pi'?`在专用或空闲会话使用 pi -e ${JSON.stringify(join(locations.plugin,'index.ts'))}，或由用户明确 /reload。`:options.harness==='hermes'?'在 Hermes 原生插件管理器中为选定 profile 启用此插件；TUI/桌面消息注入需要原生许可，CLI 投递保持 blocked。':options.harness==='dsh'?'通过原 Host 的 Cordis 插件配置启用此目录，并显式选择原有会话；不要新开 SDK 冒充已有 Host。':'项目 .agents/skills 已准备；插件包可由本地 marketplace 导入，新会话加载，现有桌面不自动重启。','安装文件不等于会话已接入；运行 doctor、connect 和 context 核对。'],conflicts};
}

export function activeInstallOwners(root:string):{id:string;owned_files:{path:string;sha256:string}[]}[]{
 const owners:{id:string;owned_files:{path:string;sha256:string}[]}[]=[];
 for(const harness of HARNESSES)for(const scope of ['project','user']){
  const marker=join(root,'.session-bridge-install',harness+'-'+scope+'.json');if(!existsSync(marker))continue;
  try{const pointer=JSON.parse(readFileSync(marker,'utf8'));if(!safeInstallPath(root,pointer.receipt_file) || !pointer.receipt_file.startsWith(join(root,'.session-bridge-install')+'/'))continue;const receipt=JSON.parse(readFileSync(pointer.receipt_file,'utf8'));if(receipt.state==='installed' && receipt.plan.targetRoot===root && Array.isArray(receipt.owned_files))owners.push(receipt);}catch{/* Invalid receipt does not claim a user file. */}
 }
 return owners;
}
