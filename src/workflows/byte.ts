import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,unlinkSync,writeFileSync } from 'node:fs';
import { join,matchesGlob } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Actor,AuthorityRef,TaskInput } from '../protocol/types.js';
import type { AuthorityCheck,AuthorityProvider } from './contract.js';
import { digest,sessionKey } from '../protocol/canonical.js';
import { scopeDigest } from './standalone.js';
import { BridgeError } from '../protocol/errors.js';
import { openStore } from '../core/database.js';
import { BindingService } from '../core/bindings.js';
const run=promisify(execFile);
export interface ByteOptions {root:string;skillPath:string;expectedSource:{commit:string;helper_sha256:string}}
interface ByteState {owner:string;owner_session:string;stage:string;history:{from_session:string;to_session:string;handoff:string}[];frozen_paths:string[]}
interface Handoff {protocol_version:1;handoff_id:string;created_at:string;source:Actor['session'];target:Actor['session'];scope:Omit<TaskInput,'authority'>;ref:AuthorityRef;from_stage:string;to_stage:string;before_epoch:number;source_commit:string;helper_sha256:string}
export interface ByteWorkflow extends AuthorityProvider {prepareByteHandoff(actor:Actor,input:TaskInput,options?:{toStage:'build'|'review'|'supervise'|'fix'}):Promise<AuthorityRef>;reconcileHandoff(ref:AuthorityRef):Promise<AuthorityCheck>;requireOwner(actor:Actor):Promise<void>;authorizeDelegation(actor:Actor,ref:AuthorityRef,input:TaskInput):Promise<AuthorityCheck>}
const nativeKey=(id:Actor['session'])=>id.harness+':'+id.native_session_id;
const denied=(reason:string):AuthorityCheck=>({state:'denied',evidence:null,reason});
function durableFile(path:string,data:unknown):void{const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(data,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
export function createByteWorkflow(options:ByteOptions):ByteWorkflow {
 const root=realpathSync(options.root),helper=join(options.skillPath,'scripts','relay_state.py'),coord=join(root,'.byte-os','coordination'),statePath=join(coord,'state.json');
 const fail=(reason:string):never=>{throw new BridgeError('byte_blocked',reason,'核对已安装 Byte 版本和当前准确 owner；不会静默切换 standalone 或改全局 Skills',3);};
 const verifySource=()=>{if(!existsSync(helper) || digestBytes(readFileSync(helper))!==options.expectedSource.helper_sha256 || !options.expectedSource.commit)fail('Installed Byte helper source is unavailable or changed');};
 const readState=():ByteState=>{verifySource();if(!existsSync(statePath) || realpathSync(statePath)!==statePath || lstatSync(statePath).isSymbolicLink())return fail('Byte state is missing or not bound to this project');const value=JSON.parse(readFileSync(statePath,'utf8')) as ByteState;if(typeof value.owner_session!=='string' || !value.owner_session.startsWith(value.owner+':') || !Array.isArray(value.history) || !Array.isArray(value.frozen_paths))return fail('Exact Byte owner/session/history is required');return value;};
 const validateActor=(actor:Actor)=>{const store=openStore(root);try{const service=new BindingService(store),b=service.get(actor.binding_id);if(!b || !service.isUsable(b.binding_id) || sessionKey(b.identity)!==sessionKey(actor.session) || actor.scope.project_id!==store.project_id)fail('Native actor binding is unavailable');const ambiguous=store.db.prepare('SELECT identity_json FROM bindings WHERE active=1 AND expires_at>?').all(new Date().toISOString()).map(row=>JSON.parse(String(row.identity_json)) as Actor['session']).filter(id=>nativeKey(id)===nativeKey(actor.session));if(ambiguous.length!==1)fail('Byte native owner is ambiguous across profiles');}finally{store.close();}};
 const requireOwner=async(actor:Actor)=>{validateActor(actor);const state=readState();if(state.owner_session!==nativeKey(actor.session) || state.owner!==actor.session.harness)fail('Byte owner authority belongs to another exact session');};
 const readHandoff=(ref:AuthorityRef):Handoff|null=>{if(!ref.handoff_id || !/^\.byte-os\/coordination\/handoffs\/sessionbridge-[a-f0-9]{64}\.json$/.test(ref.handoff_id))return null;const path=join(root,ref.handoff_id);if(!existsSync(path) || realpathSync(path)!==path)return null;try{return JSON.parse(readFileSync(path,'utf8')) as Handoff;}catch{return null;}};
 const reconcileHandoff=async(ref:AuthorityRef):Promise<AuthorityCheck>=>{
  const state=readState(),doc=readHandoff(ref),last=state.history.at(-1);
  if(!doc || digest(doc.ref)!==digest(ref) || state.history.length!==ref.epoch || doc.before_epoch+1!==ref.epoch || !last || last.handoff!==ref.handoff_id || last.from_session!==nativeKey(doc.source) || last.to_session!==nativeKey(doc.target) || state.owner_session!==nativeKey(doc.target) || ref.owner_session_key!==sessionKey(doc.target) || ref.scope_digest!==scopeDigest(doc.scope) || doc.helper_sha256!==options.expectedSource.helper_sha256)return denied('Byte handoff is absent, stale or differs from the current owner/epoch');
  return {state:'granted',evidence:digest({ref,history:last,handoff_sha256:digest(doc)})};
 };
 const check=async(actor:Actor,ref:AuthorityRef,input:TaskInput):Promise<AuthorityCheck>=>{try{await requireOwner(actor);const {authority:_authority,...scope}=input,state=readState();if(ref.workflow!=='byte' || ref.scope_digest!==scopeDigest(scope) || ref.owner_session_key!==sessionKey(actor.session) || ref.epoch!==state.history.length)return denied('Byte owner, scope or epoch mismatch');if(ref.handoff_id)return reconcileHandoff(ref);return {state:'granted',evidence:digest(state)};}catch{return denied('Byte authority is not held by this exact actor');}};
 const authorizeDelegation=async(actor:Actor,ref:AuthorityRef,input:TaskInput):Promise<AuthorityCheck>=>{validateActor(actor);const doc=readHandoff(ref),{authority:_authority,...scope}=input;if(!doc || sessionKey(doc.source)!==sessionKey(actor.session) || sessionKey(input.source)!==sessionKey(actor.session) || sessionKey(doc.target)!==sessionKey(input.target) || digest(doc.scope)!==digest(scope))return denied('No immutable Byte delegation authorized this exact source and scope');return reconcileHandoff(ref);};
 const prepareByteHandoff=async(actor:Actor,input:TaskInput,transfer?:{toStage:'build'|'review'|'supervise'|'fix'}):Promise<AuthorityRef>=>{
  validateActor(actor);verifySource();const {authority:_authority,...scope}=input;
  if(input.authority.workflow!=='byte' || !actor.scope.operations.includes('delegate_task') || sessionKey(scope.source)!==sessionKey(actor.session) || input.authority.scope_digest!==scopeDigest(scope) || scope.source.project_id!==actor.scope.project_id || scope.target.project_id!==actor.scope.project_id)fail('Byte delegation source or scope mismatch');
  const toStage=transfer?.toStage??'supervise';
  const key=digest({scope,source:actor.session,toStage}),relative='.byte-os/coordination/handoffs/sessionbridge-'+key+'.json',path=join(root,relative);
  if(existsSync(path)){const prior=JSON.parse(readFileSync(path,'utf8')) as Handoff;if(digest(prior.scope)!==digest(scope) || sessionKey(prior.source)!==sessionKey(actor.session))fail('Byte handoff identity conflict');if((await reconcileHandoff(prior.ref)).state==='granted')return prior.ref;}
  await requireOwner(actor);const state=readState();
  if(!['codex','claude','dsh','zcode'].includes(actor.session.harness) || !['codex','claude','dsh','zcode'].includes(input.target.harness))fail('Pinned Byte helper does not support pi/hermes authority; no fallback owner was created');
  if(Date.parse(input.deadline_at)<=Date.now())fail('Byte task deadline expired');
  for(const write of input.write_paths)for(const frozen of state.frozen_paths){const prefix=frozen.split(/[?*\[{}]/)[0]!.replace(/\/$/,'');if(write==='.' || matchesGlob(write,frozen) || (prefix && (prefix===write || prefix.startsWith(write+'/') || write.startsWith(prefix+'/'))))fail('Byte frozen path overlaps requested write scope');}
  const lock=join(root,'.session-bridge','byte-handoff.lock'),nonce=randomUUID();try{durableFile(lock,{pid:process.pid,nonce});}catch{return fail('Byte handoff is already in progress or needs crash reconciliation');}
  try {
   await requireOwner(actor);const current=readState();if(current.history.length!==state.history.length)fail('Byte history changed before handoff');
   const ref:AuthorityRef={workflow:'byte',handoff_id:relative,epoch:state.history.length+1,owner_session_key:sessionKey(input.target),scope_digest:scopeDigest(scope)};
   const doc:Handoff={protocol_version:1,handoff_id:relative,created_at:new Date().toISOString(),source:actor.session,target:input.target,scope,ref,from_stage:state.stage,to_stage:toStage,before_epoch:state.history.length,source_commit:options.expectedSource.commit,helper_sha256:options.expectedSource.helper_sha256};
   mkdirSync(join(coord,'handoffs'),{recursive:true});if(!existsSync(path))durableFile(path,doc);else{const existing=JSON.parse(readFileSync(path,'utf8')) as Handoff;if(digest(existing.ref)!==digest(ref))fail('Prepared Byte handoff belongs to a different epoch');}
   await run('python3',[helper,'handoff','--project',root,'--from-harness',actor.session.harness,'--from-session-id',actor.session.native_session_id,'--from-stage',state.stage,'--to-session',nativeKey(input.target),'--to-stage',toStage,'--to-host-id',input.target.host_id,'--next-action',input.goal,'--acceptance',input.acceptance.join('\n'),'--handoff',path,'--note','SessionBridge immutable handoff '+key],{timeout:10000,maxBuffer:1024*1024});
   if((await reconcileHandoff(ref)).state!=='granted')fail('Byte helper returned without the exact expected handoff');return ref;
  }finally{if(existsSync(lock) && JSON.parse(readFileSync(lock,'utf8')).nonce===nonce)unlinkSync(lock);}
 };
 return {check,authorizeDelegation,prepareByteHandoff,reconcileHandoff,requireOwner};
}
function digestBytes(bytes:Buffer):string{return createHash('sha256').update(bytes).digest('hex');}
import { createHash } from 'node:crypto';
