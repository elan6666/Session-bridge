import type { Adapter } from './contract.js';
export class AdapterRegistry {private adapters=new Map<string,Adapter>();register(harness:string,adapter:Adapter):void{this.adapters.set(harness,adapter);}get(harness:string):Adapter|undefined{return this.adapters.get(harness);}}
