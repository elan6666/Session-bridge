#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve,relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync,realpathSync } from 'node:fs';
import { z } from 'zod';
import type { CliIO } from '../protocol/types.js';
import { BridgeError } from '../protocol/errors.js';
import { initProject } from './init.js';
import { openStore } from '../core/database.js';
import { BindingService } from '../core/bindings.js';
import { listSessions } from './sessions.js';
import { currentContext,loadConnection } from './context.js';
import { parseRequest } from './request.js';
import { BridgeClient } from '../transport/client.js';
import { connectionInstructions } from './connect.js';
import { checkRuntime } from './runtime.js';
import { runDaemon } from './daemon.js';
import { connectCodex } from '../adapters/codex/connect.js';
import { planInstall,HARNESSES } from '../install/plan.js';
import { applyInstall,type InstallReceipt } from '../install/apply.js';
import { removeInstall } from '../install/remove.js';
import { executeNativeAction } from '../return/native-action.js';
import { runWithReceipt } from './run-with-receipt.js';
import { interactiveWizard } from './wizard.js';
const help=`会桥 / SessionBridge
  init --project PATH                  初始化选定目录
  connect --harness codex --alias 名字 --project PATH
  context | sessions | status          查看来源、目标或任务状态
  wizard                              中文角色选择向导（不派任务）
  request --stdin --json               Skill/脚本通用入口
  delegate | supervise | return | recover | cancel --stdin
  report | acknowledge --stdin         产物回报与原主会话验收
  action --action-id TOKEN --stdin      原主会话执行核验/下一步
  run --stdin                         执行 argv 数组并保留运行收据
  daemon start --project PATH           显式启动本项目服务，Ctrl-C 结束
  mcp --harness NAME --project PATH     stdio MCP（须可信来源）
  install --harness NAME --scope project --dry-run --project PATH
  install --harness NAME --scope project --project PATH
  uninstall --receipt PATH             仅移除本工具拥有且未被修改的条目
  doctor --project PATH                诊断；不改配置或重启应用
详细 JSON 示例见 README。CODEX_THREAD_ID 只用于匹配原生身份，不接受文本冒充来源。
`;
function inputJson(io:CliIO,args:string[]):Record<string,unknown>{if(!args.includes('--stdin'))throw new BridgeError('stdin_required','此命令需要 --stdin JSON','不要把 JSON 插值成 shell 命令',4);try{return z.record(z.string(),z.unknown()).parse(JSON.parse(io.stdin));}catch{throw new BridgeError('invalid_json','输入不是一个有效 JSON 对象','通过标准输入发送一个对象',4);}}
export async function runCli(argv:string[],io:CliIO):Promise<number>{
 try{
  checkRuntime(process.version);const [command,...args]=argv;
  if(!command){if(io.isTTY)return interactiveWizard(process.cwd());io.stdout(help+'非交互环境需要明确命令。\n');return 4;}
  if(command==='--help' || command==='help'){io.stdout(help);return 0;}
  const supported=['init','sessions','context','connect','daemon','request','delegate','supervise','return','recover','cancel','status','report','acknowledge','action','run','mcp','wizard','install','uninstall','doctor'];
  if(!supported.includes(command))throw new BridgeError('invalid_command','未知命令','运行 session-bridge --help',2);
  let root=process.env.SESSIONBRIDGE_PROJECT??process.cwd(),dryRun=false,query='',harness:string|undefined,profile:string|undefined,alias='codex',scope='project',receipt:string|undefined,actionId:string|undefined,taskId:string|undefined;
  for(let i=0;i<args.length;i++){
   const a=args[i];if(['--project','--query','--harness','--profile','--alias','--scope','--receipt','--action-id','--task'].includes(a!)){const v=args[++i];if(!v || v.startsWith('--'))throw new BridgeError('missing_value','选项缺少值','运行 --help 核对用法',4);if(a==='--project')root=resolve(v);else if(a==='--query')query=v;else if(a==='--harness')harness=v;else if(a==='--profile')profile=v;else if(a==='--alias')alias=v;else if(a==='--scope')scope=v;else if(a==='--receipt')receipt=v;else if(a==='--action-id')actionId=v;else taskId=v;}else if(a==='--dry-run')dryRun=true;else if(!['--stdin','--json'].includes(a!) && !(command==='daemon' && a==='start'))throw new BridgeError('invalid_option','未知选项：'+a,'运行 --help',4);
  }
  root=resolve(root);
  const print=(v:unknown)=>io.stdout(JSON.stringify(v)+'\n');
  if(command==='init'){print(await initProject(root,{dryRun}));return 0;}
  if(command==='wizard'){if(!io.isTTY)throw new BridgeError('tty_required','选择向导需要交互终端','自动化请使用 request --stdin --json',4);return interactiveWizard(root);}
  if(command==='install'){
   const plan=await planInstall({harness:harness??'',scope:scope as 'project'|'user',targetRoot:root});
   if(dryRun){print({state:plan.conflicts.length?'needs_input':'planned',dry_run:true,harness:plan.harness,scope:plan.scope,files:plan.files.map(f=>({path:f.path,before_sha256:f.before_sha256})),config:plan.config?{path:plan.config.path,key:plan.config.key+'.sessionbridge'}:null,conflicts:plan.conflicts,next_steps:plan.next_steps});return plan.conflicts.length?4:0;}
   const r=await applyInstall(plan);print({state:r.state,enabled:r.enabled,receipt_file:r.receipt_file,next_steps:r.plan.next_steps,conflicts:r.plan.conflicts});return r.state==='needs_input'?4:0;
  }
  if(command==='uninstall'){if(!receipt)throw new BridgeError('receipt_required','需要安装收据文件','提供 --receipt PATH',4);const r=JSON.parse(await readFile(receipt,'utf8')) as InstallReceipt;print(await removeInstall(r));return 0;}
  if(command==='doctor'){
   const checks:Record<string,unknown>={node:process.version,supported_harnesses:HARNESSES,initialized:existsSync(resolve(root,'.session-bridge/project.json')),service:'unknown',source:'unavailable',mcp_note:'共享 Codex MCP 无法证明当前聊天时拒绝写入；使用原会话 CLI。'};
   if(checks.initialized){const store=openStore(root);try{checks.sessions=(await listSessions(new BindingService(store),{query:''})).map(b=>({alias:b.alias,harness:b.identity.harness,id_suffix:b.identity.native_session_id.slice(-6),mode:b.mode}));}finally{store.close();}try{checks.source=(await currentContext(process.env,root)).identity;checks.service='reachable';}catch(error){checks.recovery=error instanceof BridgeError?error.recovery:'在原生会话连接并显式启动本项目服务';}}
   print(checks);return checks.initialized?0:3;
  }
  if(command==='connect'){if((harness??'codex')==='codex'){print(await connectCodex(root,alias));return 0;}print(connectionInstructions(harness!));return 4;}
  if(command==='mcp'){const {startMcp}=await import('../mcp/stdio.js');await startMcp({harness:harness??'codex',argv:['--project',root]});return 0;}
  if(command==='daemon'){if(!args.includes('start'))throw new BridgeError('explicit_start_required','需要显式 daemon start','运行 session-bridge daemon start --project PATH',4);const daemon=await runDaemon(root);print({state:'running',socket:daemon.address});const stop=()=>void daemon.close().then(()=>{process.exitCode=0;});process.once('SIGTERM',stop);process.once('SIGINT',stop);return 0;}
  if(command==='sessions'){const store=openStore(root);try{print({sessions:await listSessions(new BindingService(store),{query,harness,profile_id:profile})});}finally{store.close();}return 0;}
  if(command==='run'){const p=z.strictObject({argv:z.array(z.string()).min(1),source_commit:z.string(),config_sha256:z.string(),config_file:z.string().optional(),artifacts:z.array(z.string()).optional(),run_id:z.string().optional()}).parse(inputJson(io,args)),run=await runWithReceipt({root,...p});print({identity:run.identity});const result=await run.completion;print(result);return result.exit_code===0?0:6;}
  const connection=await loadConnection(process.env,root),context=await currentContext(process.env,root),client=new BridgeClient(connection);
  if(command==='context'){print(context);return 0;}
  if(command==='status'){print(await client.call(connection.actor,'get_task_status',taskId?{task_id:taskId}:{}));return 0;}
  if(command==='action'){
   if(!actionId)throw new BridgeError('action_id_required','缺少稳定动作编号','提供 --action-id TOKEN，原生历史需要包含此编号',4);
   const store=openStore(root);try{const result=await executeNativeAction(store,connection.actor,inputJson(io,args),actionId),p=inputJson(io,args);io.stderr(result.marker+'\n');const reply=await client.call(connection.actor,'acknowledge_task',{task_id:p.task_id,action:p.purpose==='verification'?'verify':'continue',evidence_file:relative(root,result.file)});print({evidence_file:relative(root,result.file),native_verification:'pending_until_native_command_completes',result:reply});}finally{store.close();}return 0;
  }
  if(['report','acknowledge'].includes(command)){print(await client.call(connection.actor,command==='report'?'report_result':'acknowledge_task',inputJson(io,args)));return 0;}
  if(command==='supervise' && args.includes('--stdin')){const p=inputJson(io,args);if('run_file' in p){print(await client.call(connection.actor,'request_supervision',p));return 0;}}
  const p=inputJson(io,args),operation=command==='request'?p.operation:({cancel:'cancel_pending',supervise:'supervise',delegate:'delegate',return:'return',recover:'recover'} as Record<string,string>)[command];
  const request=parseRequest({request_id:context.request_id,...p,operation,...(dryRun?{dry_run:true}:{})}),result=await client.call(connection.actor,'request',request) as {state:string;result?:{delivery?:{state:string}}};print(result);return ['needs_input','needs_selection'].includes(result.state)?4:result.state==='blocked'?3:result.result?.delivery?.state==='uncertain'?5:0;
 }catch(error){const e=error instanceof BridgeError?error:new BridgeError('operation_failed',error instanceof Error?error.message:'操作失败','核对项目目录、输入格式和权限',1);io.stderr(JSON.stringify({error:{code:e.code,message:e.message,recovery:e.recovery}})+'\n');return e.exitCode;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){let stdin='';if(process.argv.includes('--stdin'))for await(const chunk of process.stdin){stdin+=chunk;if(Buffer.byteLength(stdin)>65536){process.stderr.write('输入超过 64 KiB\n');process.exit(4);}}process.exitCode=await runCli(process.argv.slice(2),{stdin,stdout:s=>process.stdout.write(s),stderr:s=>process.stderr.write(s),isTTY:Boolean(process.stdin.isTTY)});}
