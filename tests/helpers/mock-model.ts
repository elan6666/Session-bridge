import { createServer,type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
type Json=Record<string,unknown>;
export interface ModelRequest {text:string;state:'received'|'holding'|'completed'}
function latestUser(body:Json):string {
 if(typeof body.input==='string')return body.input;
 let text='';for(const value of Array.isArray(body.input)?body.input:[]){const item=value as Json;if(item.role!=='user')continue;const content=item.content;text=typeof content==='string'?content:(Array.isArray(content)?content:[]).map(p=>typeof p==='object' && p && 'text' in p?String(p.text):'').join('\n');}return text;
}
function marker(text:string,name:string,fallback:string):string{return new RegExp('\\['+name+':([^\\]\\r\\n]*)\\]').exec(text)?.[1]??fallback;}
export class MockModel {
 readonly requests:ModelRequest[]=[];private gates=new Map<string,()=>void>();private server=createServer();baseUrl='';
 async start():Promise<this>{
  this.server.on('request',(req,res)=>{void this.handle(req,res).catch(()=>res.destroy());});
  await new Promise<void>(resolve=>this.server.listen(0,'127.0.0.1',resolve));const address=this.server.address();if(!address || typeof address==='string')throw new Error('No mock model address');this.baseUrl=`http://127.0.0.1:${address.port}/v1`;return this;
 }
 private async handle(req:import('node:http').IncomingMessage,res:ServerResponse):Promise<void>{
  res.on('error',()=>{});
  if(req.method!=='POST' || !req.url?.endsWith('/responses')){res.writeHead(404);res.end();return;}
  const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}
  let raw=Buffer.concat(chunks);if(req.headers['content-encoding']==='gzip')raw=gunzipSync(raw);
  const body=JSON.parse(raw.toString('utf8')) as Json,text=latestUser(body),record:ModelRequest={text,state:'received'};this.requests.push(record);
  const id='resp_test_'+randomUUID(),response:Json={id,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:body.model,output:[],error:null,incomplete_details:null};let sequence=0;
  const event=(type:string,value:Json)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:sequence++,...value})+'\n\n');
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'close'});event('response.created',{response:{...response}});event('response.in_progress',{response:{...response}});
  const hold=marker(text,'PROBE_HOLD','');
  if(hold){record.state='holding';await new Promise<void>(resolve=>{const timeout=setTimeout(()=>{this.gates.delete(hold);resolve();},30_000);this.gates.set(hold,()=>{clearTimeout(timeout);resolve();});res.once('close',()=>{clearTimeout(timeout);resolve();});});}
  const reply=marker(text,'PROBE_REPLY','MOCK_OK'),item={id:'msg_test_'+randomUUID(),type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:reply,annotations:[],logprobs:[]}]};
  event('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});
  event('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[],logprobs:[]}});
  event('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:reply,logprobs:[]});event('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:reply,logprobs:[]});event('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});event('response.output_item.done',{output_index:0,item});
  event('response.completed',{response:{...response,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}});record.state='completed';res.end();
 }
 release(gate:string):void{this.gates.get(gate)?.();this.gates.delete(gate);}
 async close():Promise<void>{for(const release of this.gates.values())release();this.gates.clear();this.server.closeAllConnections();await new Promise<void>(resolve=>this.server.close(()=>resolve()));}
}
