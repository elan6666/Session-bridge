import { BridgeError } from '../../src/protocol/errors.js';
import type { LiveOptions,LiveSessionMap } from './common/options.js';
import type { LiveReceipt } from './common/evidence.js';
export async function runClaudeLive(_options:LiveOptions,map:LiveSessionMap,receipt:LiveReceipt):Promise<void>{
 const sessions=map.participants.filter(p=>p.identity.harness==='claude');
 receipt.participants=sessions.map(p=>({role:p.role,binding_id:p.binding_id,identity:p.identity}));
 if(sessions.length<2)throw new BridgeError('claude_pair_required','Claude 原生双会话验收需要两条明确授权的已连接会话','在原生 SessionStart 插件启用后选择专用测试会话',3);
 throw new BridgeError('claude_roundtrip_pending','原生 inbox 协议已验证，完整 attached 双会话权限与回报验收尚未完成','保留原生拒收设置，在专用测试会话完成 idle、busy、拒收和 A→B→A 验收',3);
}
