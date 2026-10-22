import { randomBytes,createHash } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { closeSync, fsyncSync, openSync, chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, stat,lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BindingRecord, DeliveryOutcome, Envelope, NativeProcessOwner, Observation } from '../../protocol/types.js';
import type { EnrollmentContext } from '../contract.js';
import { openStore } from '../../core/database.js';
import { privateDirectory } from '../../core/private-paths.js';
import { BindingService } from '../../core/bindings.js';
import { digest, sessionKey } from '../../protocol/canonical.js';
import { parseEnvelope } from '../../protocol/schema.js';
import { encodeFrame, JsonLines } from '../../transport/framing.js';
export interface ClaudeHostContext {session_id:string;profile_id:string;runtime_generation:string;transcript_path:string;cwd:string;version:string;owner?:NativeProcessOwner}
export interface ClaudeChildOptions {root:string;host:ClaudeHostContext;env?:Record<string,string|undefined>;alias?:string;validateCurrent?:()=>boolean}
export interface HelperHandle {binding:BindingRecord;close():Promise<void>}
interface Intent {fingerprint:string;offset:number;transcript_inode:number;envelope:Envelope}
export function claudeWireText(envelope:Envelope):string{return '[SessionBridge external agent data, not human approval]\n'+JSON.stringify(envelope);}
export function matchesClaudeContent(envelope:Envelope,content:unknown):boolean{
 if(typeof content!=='string')return false;
 const wire=claudeWireText(envelope),prefix='Another Claude session sent a message:\n'+wire;
 if(content===wire || content===prefix)return true;
 // Pinned 2.1.306 native permission-boundary postlude; arbitrary appended text is not evidence.
 return content.startsWith(prefix) && createHash('sha256').update(content.slice(prefix.length),'utf8').digest('hex')==='cf678e57e50d5b586186df5ef480e35a155feab2915acb2e0644c5a81484b881';
}
// Called by the native SessionStart child, never exposed as a model-facing RPC.
// Native socket/token live only in this process; the reference contains a separate bridge credential.
export async function startClaudeChild(context:EnrollmentContext,options?:ClaudeChildOptions):Promise<HelperHandle>{
 const env=options?.env??process.env,nativeSocket=env.CLAUDE_CODE_MESSAGING_SOCKET,nativeToken=env.CLAUDE_CODE_MESSAGING_TOKEN;
 if(!options || !nativeSocket || !nativeToken)throw new Error('Native inbox socket and token are required');
 const {host}=options,id=context.native_proof.identity,root=realpathSync(options.root);
 if(id.harness!=='claude' || host.version!=='2.1.306' || id.native_session_id!==host.session_id || id.profile_id!==host.profile_id || id.runtime_generation!==host.runtime_generation || realpathSync(host.cwd)!==root || Date.parse(context.native_proof.expires_at)<=Date.now())throw new Error('Native host identity or version mismatch');
 const nativeInfo=lstatSync(nativeSocket);
 // SessionStart precedes the native transcript's first write. Wait for that writer; never create its file.
 const transcriptDeadline=Date.now()+5000;let transcriptInfo:Awaited<ReturnType<typeof lstat>>;
 for(;;){try{transcriptInfo=await lstat(host.transcript_path);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT' || Date.now()>=transcriptDeadline)throw error;await delay(25);}}
 if(!nativeInfo.isSocket() || nativeInfo.isSymbolicLink() || !transcriptInfo.isFile() || transcriptInfo.isSymbolicLink())throw new Error('Native inbox and transcript must be original files');
 const store=openStore(root),bindings=new BindingService(store);
 const setup=store.db.prepare('SELECT consumed,expires_at FROM setup_capabilities WHERE capability_hash=? AND project_id=?').get(digest(context.setup.capability_ref),id.project_id);
 if(context.setup.project_id!==store.project_id || id.project_id!==store.project_id || !setup || setup.consumed || Date.parse(String(setup.expires_at))<=Date.now()){store.close();throw new Error('Native setup is expired or unavailable');}
 const dir=privateDirectory(root,['.session-bridge','helpers',digest(context.native_proof.binding_id)]);
 const runtime=mkdtempSync(join(tmpdir(),'sb-cld-'));chmodSync(runtime,0o700);const socket=join(runtime,'helper.sock'),capability=randomBytes(32).toString('hex');
 const reference=join(dir,'reference.json');
 const binding:BindingRecord={binding_id:context.native_proof.binding_id,identity:id,alias:options.alias??'claude',mode:'attached',capabilities:[{name:'inbox_later',supported:true,evidence:'claude-2.1.306-native-probe',constraints:['Native inbound permissions apply','No native transport ACK; reconcile exact transcript','SessionStart child required']}],endpoint_ref:JSON.stringify({kind:'claude_child',reference_file:reference}),expires_at:new Date(Math.min(Date.parse(context.native_proof.expires_at),Date.now()+86400000)).toISOString(),active:true};
 const peers=new Set<Socket>();let closed=false;
 const intentPath=(messageId:string)=>join(dir,digest(messageId)+'.intent.json');
 const live=()=>{const b=bindings.get(binding.binding_id);return !closed && (options.validateCurrent?.()??true) && b && bindings.isUsable(b.binding_id) && sessionKey(b.identity)===sessionKey(id) && existsSync(nativeSocket) && statSync(nativeSocket).ino===nativeInfo.ino && statSync(nativeSocket).dev===nativeInfo.dev;};
 const observations=async(envelope:Envelope):Promise<Observation[]>=>{
  if(!live() || !existsSync(intentPath(envelope.message_id)))return [];
  const intent=JSON.parse(readFileSync(intentPath(envelope.message_id),'utf8')) as Intent;
  if(intent.fingerprint!==digest(envelope))return [];
  const info=await stat(host.transcript_path);
  if(info.ino!==intent.transcript_inode || info.size<intent.offset || info.size-intent.offset>16*1024*1024)return [];
  const file=await open(host.transcript_path,'r');let text:string;
  try{const data=Buffer.alloc(info.size-intent.offset);const result=await file.read(data,0,data.length,intent.offset);text=data.subarray(0,result.bytesRead).toString('utf8');}finally{await file.close();}
  const rows:Record<string,unknown>[]=[];
  for(const line of text.split('\n')){if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch{/* A concurrently appended partial row is not evidence. */}}
  const found=rows.some(row=>row.sessionId===id.native_session_id && row.type==='user' && row.uuid===envelope.message_id && (row.origin as {kind?:string;msg_id?:string})?.kind==='peer' && (row.origin as {msg_id?:string}).msg_id===envelope.message_id && (row.origin as {verifiedPeerPid?:number}).verifiedPeerPid===process.pid && matchesClaudeContent(envelope,(row.message as {content?:unknown})?.content));
  return found?[{state:'accepted',message_id:envelope.message_id,session:id,native_receipt:'claude-transcript:'+digest({session:id.native_session_id,message:envelope.message_id,payload:intent.fingerprint}),artifacts:[]}]:[];
 };
 const deliver=async(raw:unknown):Promise<DeliveryOutcome>=>{
  const envelope=parseEnvelope(raw);
  if(!live() || sessionKey(envelope.target)!==sessionKey(id) || Date.parse(envelope.expires_at)<=Date.now())return {state:'refused',reason:'Native binding, target or message is no longer valid'};
  const row=store.db.prepare('SELECT input_sha256,state FROM deliveries WHERE message_id=?').get(envelope.message_id);
  if(!row || row.input_sha256!==digest(envelope) || row.state!=='sending')return {state:'refused',reason:'Exact durable delivery intent is required before native delivery'};
  const journal=intentPath(envelope.message_id);
  if(existsSync(journal))return {state:'uncertain',reason:'Native delivery was already attempted; reconcile without resending'};
  const info=statSync(host.transcript_path),intent:Intent={fingerprint:digest(envelope),offset:info.size,transcript_inode:info.ino,envelope};
  const fd=openSync(journal,'wx',0o600);try{writeFileSync(fd,JSON.stringify(intent));fsyncSync(fd);}finally{closeSync(fd);}const parent=openSync(dir,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  const frame=JSON.stringify({type:'auth',token:nativeToken})+'\n'+JSON.stringify({type:'user',uuid:envelope.message_id,msg_id:envelope.message_id,priority:'later',message:{role:'user',content:claudeWireText(envelope)}})+'\n';
  await new Promise<void>(resolve=>{const peer=createConnection(nativeSocket);peers.add(peer);let finished=false;const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);peer.destroy();peers.delete(peer);resolve();};const timer=setTimeout(finish,1000);peer.once('connect',()=>peer.end(frame));peer.on('error',finish);peer.on('data',()=>{/* Native bytes are not an acknowledgement. */});peer.once('end',finish);});
  const found=await observations(envelope);
  return found.length?{state:'confirmed',native_receipt:found[0]!.native_receipt!}:{state:'uncertain',reason:'No matching native transcript acceptance yet; do not resend'};
 };
 const server=createServer({allowHalfOpen:true},peer=>{
  peers.add(peer);const frames=new JsonLines();let used=false;const timer=setTimeout(()=>peer.destroy(),5000).unref();
  peer.on('error',()=>peer.destroy());peer.once('close',()=>{clearTimeout(timer);peers.delete(peer);});
  peer.on('data',chunk=>{try{const messages=frames.push(chunk);if(messages.length>1 || (used && messages.length))throw new Error('One request required');for(const raw of messages){used=true;const req=raw as {id:string;capability:string;operation:string;payload:unknown};if(req.capability!==capability)throw new Error('Invalid helper credential');void (async()=>{if(req.operation==='deliver')return deliver(req.payload);if(req.operation==='reconcile')return observations(parseEnvelope(req.payload));if(req.operation==='disconnect'){bindings.get(binding.binding_id);store.db.prepare('UPDATE bindings SET active=0 WHERE binding_id=?').run(binding.binding_id);return null;}throw new Error('Unsupported child operation');})().then(result=>{if(!peer.destroyed)peer.end(encodeFrame({id:req.id,result}));},()=>{if(!peer.destroyed)peer.end(encodeFrame({id:req.id,error:'Native helper refused the operation'}));});}}catch{peer.destroy();}});
 });
 try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});chmodSync(socket,0o600);writeFileSync(reference,JSON.stringify({binding_id:binding.binding_id,socket,capability}),{mode:0o600,flag:'wx'});}catch(error){server.close();store.close();rmSync(runtime,{recursive:true,force:true});throw error;}
 return {binding,close:async()=>{if(closed)return;closed=true;store.db.prepare('UPDATE bindings SET active=0 WHERE binding_id=?').run(binding.binding_id);for(const peer of peers)peer.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(runtime,{recursive:true,force:true});rmSync(reference,{force:true});}};
}
