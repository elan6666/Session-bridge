import { BridgeError } from '../../src/protocol/errors.js';
import type { LiveOptions,LiveSessionMap } from './common/options.js';
import type { LiveReceipt } from './common/evidence.js';
export async function runPiLive(_options:LiveOptions,map:LiveSessionMap,receipt:LiveReceipt):Promise<void>{
 receipt.participants=map.participants.filter(p=>p.identity.harness==='pi').map(p=>({role:p.role,binding_id:p.binding_id,identity:p.identity}));
 throw new BridgeError('pi_attached_pending','Pi 类型与插件生命周期已核验，原生已打开会话的真实模型验收尚未完成','在原生会话显式启用扩展后选择专用验收会话；不以新 SDK 会话代替',3);
}
