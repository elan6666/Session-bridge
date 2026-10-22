import { BridgeError } from '../../src/protocol/errors.js';
import type { LiveOptions,LiveSessionMap } from './common/options.js';
import type { LiveReceipt } from './common/evidence.js';
// Dispatching a bridge task requires the original native source. The old external
// smoke driver borrowed a main capability and is deliberately disabled. Actual
// source-driven smoke evidence is collected separately; this is never a pass.
export async function runCodexLive(options:LiveOptions,map:LiveSessionMap,receipt:LiveReceipt):Promise<LiveReceipt>{
 void options;void map;void receipt;
 throw new BridgeError('original_source_execution_required','外部验收程序不能借用主会话身份创建任务','在选定原主会话通过 Skill 派发；使用 collaboration 只读核对实际任务与收据',3);
}
