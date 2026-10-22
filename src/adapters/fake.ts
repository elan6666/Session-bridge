import { DatabaseSync } from 'node:sqlite';
import type { Adapter, CapabilityReport, EnrollmentContext } from './contract.js';
import type { BindingRecord, DeliveryOutcome, Envelope, Observation } from '../protocol/types.js';
import { BridgeError } from '../protocol/errors.js';
export class FakeAdapter implements Adapter {
 private db:DatabaseSync;
 constructor(path:string){this.db=new DatabaseSync(path);this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY AUTOINCREMENT,envelope_json TEXT NOT NULL);');}
 get enqueueCount():number{return Number(this.db.prepare('SELECT count(*) n FROM queue').get()?.n);}
 async probe():Promise<CapabilityReport>{return {harness:'fake',version:'test',modes:{attached:{supported:true,evidence:'test transport only',constraints:['Not a real harness']}},capabilities:[]};}
 async discover():Promise<BindingRecord[]>{return [];}
 async enroll(_context:EnrollmentContext):Promise<BindingRecord>{throw new BridgeError('unsupported','Fake transport cannot enroll real sessions','Use an actual host connector',3);}
 async deliver(envelope:Envelope):Promise<DeliveryOutcome>{const row=this.db.prepare('INSERT INTO queue(envelope_json) VALUES (?)').run(JSON.stringify(envelope));return {state:'confirmed',native_receipt:String(row.lastInsertRowid)};}
 async reconcile(envelope:Envelope):Promise<Observation[]>{return this.db.prepare('SELECT * FROM queue').all().filter(row=>(JSON.parse(String(row.envelope_json)) as Envelope).message_id===envelope.message_id).map(row=>({state:'accepted',message_id:envelope.message_id,session:envelope.target,native_receipt:String(row.id),artifacts:[]}));}
 async *observe(_binding:BindingRecord,_signal:AbortSignal):AsyncIterable<Observation>{return;}
 async disconnect(_bindingId:string):Promise<void>{this.db.close();}
}
