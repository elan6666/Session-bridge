import { existsSync,readFileSync,realpathSync } from 'node:fs';
import { dirname,join } from 'node:path';
export function locateCore(pluginRoot){
 const locator=join(pluginRoot,'.sessionbridge-runtime.json');
 if(existsSync(locator)){const value=JSON.parse(readFileSync(locator,'utf8'));const root=realpathSync(value.core_root);if(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).name!=='@sessionbridge/local')throw new Error('SessionBridge runtime mismatch');return root;}
 let dir=realpathSync(pluginRoot);for(let depth=0;depth<5;depth++){const path=join(dir,'package.json');if(existsSync(path) && JSON.parse(readFileSync(path,'utf8')).name==='@sessionbridge/local')return dir;const parent=dirname(dir);if(parent===dir)break;dir=parent;}
 throw new Error('请先安装会桥核心并运行 session-bridge install；插件没有可用的本机运行时。');
}
