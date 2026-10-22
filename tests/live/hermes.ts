import { BridgeError } from '../../src/protocol/errors.js';
import type { LiveOptions,LiveSessionMap } from './common/options.js';
import type { LiveReceipt } from './common/evidence.js';
export async function runHermesLive(options:LiveOptions,map:LiveSessionMap,receipt:LiveReceipt):Promise<void>{
 receipt.participants=map.participants.filter(p=>p.identity.harness==='hermes').map(p=>({role:p.role,binding_id:p.binding_id,identity:p.identity}));
 if(options.surface==='cli')throw new BridgeError('hermes_cli_idle_boundary_unavailable','已安装 Hermes CLI 的注入在 busy 时进入中断队列，未找到原子空闲投递入口','CLI 保持 blocked；TUI/桌面端的原生队列另行验收，不更改 allow_gateway_injection',3);
 throw new BridgeError('hermes_tui_attached_pending','Hermes TUI／桌面原生排队已做源码核验，实际会话与模型验收尚未完成','显式启用原生插件并选择专用验收会话；未测界面保持 untested',3);
}
