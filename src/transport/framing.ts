import type { Clock } from '../protocol/types.js';
import { systemClock } from '../protocol/types.js';
import { BridgeError } from '../protocol/errors.js';
export const MAX_FRAME_BYTES=64*1024;
export const PARTIAL_FRAME_MS=5000;
export class JsonLines {
 private buffer=Buffer.alloc(0);
 private started:number|null=null;
 constructor(private clock:Clock=systemClock){}
 get partial():boolean{return this.buffer.length>0;}
 checkTimeout():void {if(this.started!==null && this.clock.now().getTime()-this.started>=PARTIAL_FRAME_MS)throw new BridgeError('frame_timeout','Partial frame deadline exceeded','Reconnect and send one complete JSON line',3);}
 push(chunk:Buffer):unknown[]{
  this.checkTimeout();const result:unknown[]=[];
  let offset=0;
  while(offset<chunk.length){
   const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline;
   const part=chunk.subarray(offset,end);
   if(this.buffer.length+part.length>MAX_FRAME_BYTES)throw new BridgeError('frame_too_large','JSON frame exceeds 64 KiB limit','Use an artifact reference for large content');
   if(this.started===null && part.length)this.started=this.clock.now().getTime();
   this.buffer=Buffer.concat([this.buffer,part]);
   if(newline<0)break;
   try{result.push(JSON.parse(this.buffer.toString('utf8')));}catch{throw new BridgeError('invalid_frame','Invalid JSON frame','Send UTF-8 JSON followed by a newline');}
   this.buffer=Buffer.alloc(0);this.started=null;offset=newline+1;
  }
  return result;
 }
}
export function encodeFrame(value:unknown):Buffer {
 const data=Buffer.from(JSON.stringify(value),'utf8');
 if(data.length>MAX_FRAME_BYTES)throw new BridgeError('frame_too_large','JSON frame exceeds 64 KiB limit','Use an artifact reference for large content');
 return Buffer.concat([data,Buffer.from('\n')]);
}
