import { readFile,lstat } from 'node:fs/promises';
import { openStore } from '../../src/core/database.js';
import { BindingService } from '../../src/core/bindings.js';
import { readLiveMap,type LiveOptions } from './common/options.js';
import { sessionKey } from '../../src/protocol/canonical.js';
import { validateCodexBinary,readCodexOwner } from '../../src/adapters/codex/version.js';
export interface LivePreflight {status:'passed'|'blocked';participants:{harness:string;bound:boolean;mode:string|null;native_context:boolean;reason:string|null}[];messages_sent:0}
export async function preflightLive(options:LiveOptions):Promise<LivePreflight>{
 const map=await readLiveMap(options),store=openStore(map.project_root),bindings=new BindingService(store),participants:LivePreflight['participants']=[];
 try{for(const harness of ['codex','claude','pi','dsh','hermes']){
  const selected=map.participants.filter(p=>p.identity.harness===harness);let verified=false,reason:string|null='未选定并验证原生会话',mode:string|null=null;
  for(const p of selected){const b=bindings.get(p.binding_id);if(!b || !bindings.isUsable(b.binding_id) || sessionKey(b.identity)!==sessionKey(p.identity))continue;mode=b.mode;
   if(harness==='codex' && map.native?.codex){try{const native=map.native.codex;await validateCodexBinary(native.desktop_binary,native.expected_version);const endpoint=JSON.parse(b.endpoint_ref),owner=await readCodexOwner(endpoint.owner.pid);verified=owner.executable===native.desktop_binary && owner.started_at===endpoint.owner.started_at;reason=verified?null:'原执行者已变化';}catch{reason='原桌面版本/profile/执行者未核实';}}
   else if(p.native_receipt_file){try{const info=await lstat(p.native_receipt_file);if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o077)!==0)throw new Error('unsafe');const proof=JSON.parse(await readFile(p.native_receipt_file,'utf8'));verified=proof.identity_sha256===sessionKey(p.identity) && proof.actual_native_tool_success===true && proof.model==='glm-5.3-flash' && proof.synthetic!==true;reason=verified?null:'缺实际原生工具与来源证明';}catch{reason='原生收据不可用';}}
  }
  participants.push({harness,bound:selected.some(p=>bindings.isUsable(p.binding_id)),mode,native_context:verified,reason});
 }return {status:participants.every(p=>p.bound && p.native_context)?'passed':'blocked',participants,messages_sent:0};}finally{store.close();}
}
