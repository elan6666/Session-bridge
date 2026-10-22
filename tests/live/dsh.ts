import { BridgeError } from '../../src/protocol/errors.js';
import type { LiveOptions,LiveSessionMap } from './common/options.js';
import type { LiveReceipt } from './common/evidence.js';
export async function runDshLive(_options:LiveOptions,map:LiveSessionMap,receipt:LiveReceipt):Promise<void>{
 receipt.participants=map.participants.filter(p=>p.identity.harness==='dsh').map(p=>({role:p.role,binding_id:p.binding_id,identity:p.identity}));
 throw new BridgeError('dsh_native_host_acceptance_pending','dsh 原 Host 插件的实际 Web／桌面会话与 GLM 运行尚未验收','显式安装到原生 Host，登记原有会话；SDK 新进程只能记 managed',3);
}
