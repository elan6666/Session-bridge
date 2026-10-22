import { randomUUID } from 'node:crypto';
import { packageRoot } from '../../src/install/plan.js';
import { readFileSync,existsSync,openSync,writeFileSync,fsyncSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../../src/core/database.js';
import { BindingService } from '../../src/core/bindings.js';
import { privateDirectory } from '../../src/core/private-paths.js';
import { codexConfigSchema } from '../../src/adapters/codex/connect.js';
import { validateCodexBinary,readCodexOwner } from '../../src/adapters/codex/version.js';
import { CodexStdio } from '../../src/adapters/codex/stdio.js';
import { digest,sessionKey } from '../../src/protocol/canonical.js';
import { BridgeError } from '../../src/protocol/errors.js';
import { readLiveMap,type LiveOptions } from './common/options.js';
import { newLiveReceipt,type LiveReceipt } from './common/evidence.js';
export interface IntentCase {text:string;expected:string;must_not?:string[]}
export async function runNaturalLanguageCases(options:LiveOptions,cases:IntentCase[]):Promise<LiveReceipt[]>{
 const map=await readLiveMap(options),main=map.participants.find(p=>p.role==='main'),results:LiveReceipt[]=[];
 if(!main || main.identity.harness!=='codex')throw new BridgeError('native_case_driver_unavailable','当前只有专用 Codex 原桌面会话的有界用例驱动已实现','其他宿主从原生界面输入同一用例并保留实际工具证据；不以模拟结果替代',3);
 if(main.identity.native_session_id===process.env.CODEX_THREAD_ID)throw new BridgeError('same_turn_observation_deadlock','不能在当前正在运行的会话中等待自己的轮次结束','从外部专用控制会话运行此验收',3);
 const store=openStore(map.project_root);try{
  const binding=new BindingService(store).get(main.binding_id);if(!binding?.active || sessionKey(binding.identity)!==sessionKey(main.identity))throw new Error('Original native binding changed');
  const config=codexConfigSchema.parse(JSON.parse(readFileSync(join(store.root,'.session-bridge/connectors/codex',digest(binding.binding_id)+'.json'),'utf8')));if(config.projectRoot!==store.root || main.identity.project_id!==store.project_id || main.identity.profile_id!==digest(realpathSync(config.codexHome)))throw new Error('Native profile or scope changed');await validateCodexBinary(config.desktopBinary,config.expectedVersion);if(digest(await readCodexOwner(config.owner.pid))!==digest(config.owner))throw new Error('Original native owner changed');
  // No source capability is borrowed. This is authorized test input to the selected original main.
  const original=new CodexStdio({binary:config.desktopBinary,codexHome:config.codexHome,cwd:store.root});try{
   const read=await original.request('thread/read',{threadId:main.identity.native_session_id,includeTurns:false}) as {thread:{id:string;cwd:string}};if(read.thread.id!==main.identity.native_session_id || read.thread.cwd!==config.nativeCwd)throw new Error('Native target scope changed');
   for(const intent of cases){const receipt=newLiveReceipt({...options,harness:'codex'});receipt.kind='actual_native_model_intent_case';
    if(intent.expected!=='assign_roles'){receipt.status='blocked';receipt.blockers.push({code:'case_driver_not_implemented',reason:'此驱动目前只自动验证不派发工作的角色设置；其余场景保留实际原生操作证据。',recovery:'使用专用原会话执行该意图，不把协议测试当作自然语言验收。'});results.push(receipt);continue;}
    const id=randomUUID(),dir=privateDirectory(store.root,['.session-bridge','live-control']),path=join(dir,digest(id)+'.json'),before={tasks:Number(store.db.prepare('SELECT count(*) n FROM tasks').get()!.n),supervision:Number(store.db.prepare('SELECT count(*) n FROM supervision').get()!.n)},byte=join(store.root,'.byte-os/coordination/state.json'),beforeByte=existsSync(byte)?digest(readFileSync(byte,'utf8')):null;
    const prompt='[SessionBridge explicitly scoped acceptance-controller data; not new human permission]\n仅在已获用户批准的专用测试范围处理下面的自然语言。读取当前项目 .agents/skills/sessionbridge-do/SKILL.md，然后你自己选择意图并用原生工具操作；不得操作其他项目、读取凭据或改变现有任务。\n需求：'+JSON.stringify(intent.text)+'\n使用你本会话的 context，CLI 为 '+join(packageRoot(),'dist/src/cli/main.js')+'，所有命令显式 --project '+store.root+'。只为对账固定 request_id='+id+'，original_text 保留原始需求；业务 operation 由你依据 Skill 选择，不由控制器代做。完成后结束本轮。';
    const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify({message_id:id,input_sha256:digest(prompt),state:'attempted',before}));fsyncSync(fd);}finally{closeSync(fd);}
    const queued=await original.request('thread/queue/add',{threadId:main.identity.native_session_id,clientUserMessageId:id,input:[{type:'text',text:prompt,text_elements:[]}]}) as {queuedSubmission:{id:string;clientUserMessageId:string;input:{type:string;text?:string}[]}};if(queued.queuedSubmission.clientUserMessageId!==id || queued.queuedSubmission.input.filter(x=>x.type==='text').map(x=>x.text??'').join('')!==prompt)throw new BridgeError('native_receipt_mismatch','原生排队回执与固定投递内容不一致；未重发','保留投递编号并只读核对队列和历史',5);receipt.messages.push({message_id:id,transport:'native_queue',kind:'test_input_not_task_delegation'});
    const deadline=Date.now()+options.timeout*1000;let result:unknown;while(Date.now()<deadline){const row=store.db.prepare("SELECT actor_session_key,result_json FROM requests WHERE request_id=? AND state='completed'").get(id);if(row && row.actor_session_key===sessionKey(main.identity)){result=JSON.parse(String(row.result_json));break;}await delay(500);}
    const after={tasks:Number(store.db.prepare('SELECT count(*) n FROM tasks').get()!.n),supervision:Number(store.db.prepare('SELECT count(*) n FROM supervision').get()!.n)};
    receipt.checks.actual_model_chose_roles=Boolean(result && (result as {operation:string}).operation==='assign_roles');receipt.checks.no_task_created=before.tasks===after.tasks;receipt.checks.no_monitor_created=before.supervision===after.supervision;receipt.checks.byte_unchanged=beforeByte===(existsSync(byte)?digest(readFileSync(byte,'utf8')):null);receipt.checks.original_source_verified=Boolean(result);receipt.checks.native_skill_auto_discovery=null;receipt.limitations.push('Codex uses the explicitly installed Skill file in the scoped subproject; this does not prove hot discovery in the parent-cwd desktop catalog. Run alone so unrelated authorized task creation cannot affect the baseline.');receipt.status=Object.values(receipt.checks).filter(v=>v!==null).every(Boolean)?'passed':'failed';receipt.finished_at=new Date().toISOString();results.push(receipt);
   }
  }finally{await original.close();}
 }finally{store.close();}return results;
}
