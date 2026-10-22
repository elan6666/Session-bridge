import { pathToFileURL } from 'node:url';
import { runNaturalLanguageCases } from './natural-language.js';
import { preflightLive } from './preflight.js';
import { runCollaboration } from './collaboration.js';
import { BridgeError } from '../../src/protocol/errors.js';
import { parseLiveOptions,readLiveMap,type LiveOptions } from './common/options.js';
import { newLiveReceipt,saveLiveReceipt,type LiveReceipt } from './common/evidence.js';
import { runCodexLive } from './codex.js';
import { runDshLive } from './dsh.js';
import { runHermesLive } from './hermes.js';
import { runPiLive } from './pi.js';
import { runClaudeLive } from './claude.js';
export async function runLiveCase(options:LiveOptions):Promise<LiveReceipt>{
 const receipt=newLiveReceipt(options);
 try{const map=await readLiveMap(options);if(options.case==='preflight'){const p=await preflightLive(options);receipt.kind='readonly_native_preflight';receipt.status=p.status;receipt.participants=p.participants;receipt.blockers=p.participants.filter(x=>!x.native_context).map(x=>({code:'native_harness_not_verified',reason:x.harness+': '+x.reason,recovery:'在选定原生会话连接并取得真实模型工具收据'}));receipt.finished_at=new Date().toISOString();return receipt;}if(options.case==='natural-language'){const results=await runNaturalLanguageCases(options,[{text:'帮我用这个会话当主agent，另一个验收监督者会话当监督agent',expected:'assign_roles'}]);return results[0]!;}if(options.case==='collaboration')return runCollaboration(options);if(options.harness==='codex' && options.case==='attached')await runCodexLive(options,map,receipt);else if(options.harness==='claude' && options.case==='attached-and-native')await runClaudeLive(options,map,receipt);else if(options.harness==='pi' && options.case==='attached')await runPiLive(options,map,receipt);else if(options.harness==='hermes' && options.case==='attached')await runHermesLive(options,map,receipt);else if(options.harness==='dsh' && options.case==='attached')await runDshLive(options,map,receipt);else throw new BridgeError('live_case_not_ready','该宿主／用例尚未完成接入验收','先完成相应原生连接器；不会以 managed 或模拟用例代替',3);}
 catch(error){const e=error instanceof BridgeError?error:new BridgeError('live_precondition_failed','真实验收前置或证据检查未通过','检查私密会话表、实际连接、原生权限和产物收据',3);receipt.status=e.exitCode===6?'failed':'blocked';receipt.blockers.push({code:e.code,reason:e.message,recovery:e.recovery});}
 receipt.finished_at=new Date().toISOString();return receipt;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){try{const options=parseLiveOptions(process.argv.slice(2)),receipt=await runLiveCase(options);const evidence=await saveLiveReceipt(receipt,options.isolatedRoot);process.stdout.write(JSON.stringify({receipt,evidence})+'\n');process.exitCode=receipt.status==='passed'?0:receipt.status==='blocked'?3:6;}catch(error){process.stderr.write(JSON.stringify({error:error instanceof BridgeError?{code:error.code,message:error.message,recovery:error.recovery}:{code:'invalid_options'}})+'\n');process.exitCode=2;}}
