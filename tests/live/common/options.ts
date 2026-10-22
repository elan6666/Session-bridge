import { z } from 'zod';
import { lstat,readFile } from 'node:fs/promises';
import { BridgeError } from '../../../src/protocol/errors.js';
import { nonempty,sessionSchema } from '../../../src/protocol/schema.js';
export interface LiveOptions {harness?:string;case:string;sessionMap?:string;isolatedRoot?:string;timeout:number;provider?:string;surface?:string}
const participant=z.strictObject({role:nonempty,binding_id:nonempty,identity:sessionSchema,connection_file:nonempty.optional(),native_receipt_file:nonempty.optional()});
const mapSchema=z.strictObject({protocol_version:z.literal(1),purpose:z.literal('live_acceptance'),project_root:nonempty,participants:z.array(participant).min(1),native:z.object({codex:z.strictObject({desktop_binary:nonempty,codex_home:nonempty,expected_version:nonempty}).optional()}).optional()});
export type LiveSessionMap=z.infer<typeof mapSchema>;
export async function readLiveMap(options:LiveOptions):Promise<LiveSessionMap>{
 if(!options.sessionMap)throw new BridgeError('explicit_session_map_required','未指定专属验收会话；未向任何工作会话投递','在连接向导明确选择专属验收会话，再提供 --session-map；不会将参照会话自动用作测试',3);
 const info=await lstat(options.sessionMap);
 if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o077)!==0 || (process.getuid && info.uid!==process.getuid()))throw new BridgeError('unsafe_session_map','验收会话表必须是本用户的私密普通文件','通过会桥连接向导重新生成 0600 的会话表',3);
 const parsed=mapSchema.safeParse(JSON.parse(await readFile(options.sessionMap,'utf8')));
 if(!parsed.success)throw new BridgeError('invalid_session_map','会话表不是显式 live_acceptance 授权表','普通角色表不能用于真实验收，请明确选择验收用途',3);
 return parsed.data;
}
export function parseLiveOptions(argv:string[]):LiveOptions{
 const result:LiveOptions={case:'preflight',timeout:120};const options:Record<string,keyof LiveOptions>={'--harness':'harness','--case':'case','--session-map':'sessionMap','--root':'isolatedRoot','--timeout':'timeout','--provider':'provider','--surface':'surface'};
 for(let i=0;i<argv.length;i++){const key=options[argv[i]!],value=argv[++i];if(!key || !value)throw new BridgeError('invalid_live_option','Unknown or missing live option','Use --harness NAME --case CASE --session-map PATH --timeout SECONDS');if(key==='timeout'){const seconds=Number(value);if(!Number.isInteger(seconds) || seconds<=0 || seconds>3600)throw new BridgeError('invalid_timeout','Live timeout must be 1–3600 seconds','Provide an explicit bounded timeout');result.timeout=seconds;}else result[key]=value;}
 return result;
}
