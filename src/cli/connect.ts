import { BridgeError } from '../protocol/errors.js';
const supported=['codex','claude','pi','hermes','dsh'];
export function connectionInstructions(harness:string):{harness:string;state:'needs_setup';steps:string[]}{
 if(!supported.includes(harness))throw new BridgeError('unsupported_harness','No verified connector is available for this harness','Choose codex, claude, pi, hermes or dsh',3);
 return {harness,state:'needs_setup',steps:['在目标原会话中启用 SessionBridge 插件/Skill。','通过该宿主的 connect 命令验证原生身份，选择项目和别名。','完成绑定后运行 session-bridge context --json 核对当前会话；不要选择最近历史代替。']};
}
