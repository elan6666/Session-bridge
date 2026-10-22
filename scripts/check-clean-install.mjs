import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=mkdtempSync('/tmp/sb-clean-'),home=join(root,'home'),prefix=join(root,'prefix'),project=join(root,'project');for(const d of [home,prefix,project])mkdirSync(d,{mode:0o700});
const env={...process.env,HOME:home,CODEX_HOME:join(home,'.codex'),SESSIONBRIDGE_PROJECT:project};delete env.SESSIONBRIDGE_CONNECTION;delete env.CODEX_THREAD_ID;delete env.CLAUDE_CODE_MESSAGING_SOCKET;
const tarball=resolve(process.argv[2]??'sessionbridge-local-0.1.0.tgz');
const run=(file,args,options={})=>execFileSync(file,args,{env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,...options});
try{
 run('npm',['install','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund',tarball]);const cli=join(prefix,'node_modules/@sessionbridge/local/dist/src/cli/main.js'),call=args=>JSON.parse(run(process.execPath,[cli,...args]));
 call(['init','--project',project]);writeFileSync(join(project,'.mcp.json'),JSON.stringify({mcpServers:{existing:{command:'keep'}},provider:{model:'unchanged'}}));const before=readFileSync(join(project,'.mcp.json'),'utf8');
 const dry=call(['install','--harness','claude','--project',project,'--dry-run']);if(!dry.dry_run || readFileSync(join(project,'.mcp.json'),'utf8')!==before)throw new Error('Dry run wrote configuration');
 const installed=call(['install','--harness','claude','--project',project]),conf=JSON.parse(readFileSync(join(project,'.mcp.json'),'utf8'));if(conf.provider.model!=='unchanged' || !conf.mcpServers.existing)throw new Error('Provider changed');
 conf.userAddition='keep';writeFileSync(join(project,'.mcp.json'),JSON.stringify(conf));call(['uninstall','--receipt',installed.receipt_file]);const after=JSON.parse(readFileSync(join(project,'.mcp.json'),'utf8'));if(after.userAddition!=='keep' || after.mcpServers.sessionbridge || after.provider.model!=='unchanged')throw new Error('Removal changed user data');
 run(process.execPath,['--input-type=module','-e',"await import('@modelcontextprotocol/sdk/server/stdio.js'); await import('zod'); console.log('ready')"],{cwd:join(prefix,'node_modules/@sessionbridge/local')});
 const packageRoot=join(prefix,'node_modules/@sessionbridge/local');for(const required of ['README.md','README.zh-CN.md','docs/support.md','docs/support.en.md','docs/cli.md','docs/cli.zh-CN.md','assets/sessionbridge-banner.svg','assets/overview.svg','assets/overview.zh-CN.svg'])if(!existsSync(join(packageRoot,required)))throw new Error('Product documentation or artwork missing from tarball');if(!existsSync(join(packageRoot,'.agents/plugins/marketplace.json')))throw new Error('Native marketplace missing from tarball');
 for(const path of ['AGENTS.md','.byte-os','.superpowers','evidence','docs/acceptance','docs/superpowers','docs/research','docs/maintenance','docs/distribution'])if(existsSync(join(packageRoot,path)))throw new Error('Package contains local development records');
 const harnesses=['codex','claude','pi','dsh','hermes'],receipts=[];
 for(const harness of harnesses){const planned=call(['install','--harness',harness,'--scope','project','--project',project,'--dry-run']);if(planned.state!=='planned')throw new Error(harness+' dry run failed');const installed=call(['install','--harness',harness,'--scope','project','--project',project]);if(installed.state!=='installed' || installed.enabled!==false)throw new Error(harness+' installation changed activation contract');receipts.push(installed.receipt_file);}
 for(const receipt of receipts)call(['uninstall','--receipt',receipt]);
 const preserved=JSON.parse(readFileSync(join(project,'.mcp.json'),'utf8'));if(preserved.userAddition!=='keep' || preserved.provider.model!=='unchanged' || preserved.mcpServers.existing.command!=='keep' || preserved.mcpServers.sessionbridge)throw new Error('Five-host uninstall changed user configuration');
 run('npm',['uninstall','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund','@sessionbridge/local']);
 console.log(JSON.stringify({state:'passed',isolated_home:true,tarball:true,provider_preserved:true,user_edits_preserved:true,bundled_mcp_runtime:true,native_marketplace:true,npm_uninstalled:true,project_plugins_installed_and_removed:harnesses,automatic_activation:false}));
}finally{rmSync(root,{recursive:true,force:true});}
