import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError } from '../protocol/errors.js';
export interface BridgeStore { db:DatabaseSync; project_id:string; root:string; close():void }
const migrations=[`
CREATE TABLE bindings(binding_id TEXT PRIMARY KEY,native_key TEXT NOT NULL,session_key TEXT NOT NULL,identity_json TEXT NOT NULL,alias TEXT NOT NULL,mode TEXT NOT NULL,capabilities_json TEXT NOT NULL,endpoint_ref TEXT NOT NULL,expires_at TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)));
CREATE UNIQUE INDEX one_active_generation ON bindings(native_key) WHERE active=1;
CREATE TABLE tasks(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,input_json TEXT NOT NULL,input_sha256 TEXT NOT NULL,event_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE deliveries(message_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,envelope_json TEXT NOT NULL,input_sha256 TEXT NOT NULL,state TEXT NOT NULL,event_seq INTEGER NOT NULL DEFAULT 0,native_receipt TEXT,reason TEXT,route_id TEXT NOT NULL,lease_holder TEXT,lease_until TEXT);
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,subject_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE supervision(id TEXT PRIMARY KEY,request_json TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0,last_event_id TEXT,next_check_at TEXT NOT NULL);
CREATE TABLE leases(id TEXT PRIMARY KEY,holder TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE setup_capabilities(capability_hash TEXT PRIMARY KEY,project_id TEXT NOT NULL,expires_at TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
`, `
CREATE TABLE session_capabilities(capability_hash TEXT PRIMARY KEY,binding_id TEXT NOT NULL,actor_json TEXT NOT NULL,expires_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE context_challenges(challenge_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,capability_hash TEXT NOT NULL,identity_sha256 TEXT NOT NULL,response_sha256 TEXT NOT NULL,expires_at TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
`, `
CREATE TABLE role_assignments(main_session_key TEXT PRIMARY KEY,main_identity_json TEXT NOT NULL,supervisor_identity_json TEXT NOT NULL,updated_by_binding_id TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE requests(request_id TEXT PRIMARY KEY,actor_session_key TEXT NOT NULL,input_sha256 TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,task_id TEXT,message_id TEXT);
`, `
CREATE TABLE plugin_attempts(message_id TEXT PRIMARY KEY,session_key TEXT NOT NULL,input_sha256 TEXT NOT NULL);
CREATE TABLE plugin_observations(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL,session_key TEXT NOT NULL,observation_json TEXT NOT NULL);
`, `
CREATE UNIQUE INDEX one_byte_task_per_handoff ON tasks(json_extract(input_json,'$.authority.handoff_id')) WHERE json_extract(input_json,'$.authority.workflow')='byte';
`, `
CREATE TABLE pending_run_checks(lease_id TEXT PRIMARY KEY,first_seen TEXT NOT NULL);
CREATE TABLE run_events(event_id TEXT PRIMARY KEY,lease_id TEXT NOT NULL,proof_json TEXT NOT NULL,created_at TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,dispatch_state TEXT NOT NULL);
`, `
CREATE TABLE task_cancellations(task_id TEXT PRIMARY KEY,source_session_key TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE task_results(task_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,result_json TEXT NOT NULL,reported_at TEXT NOT NULL);
CREATE TABLE task_returns(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,result_sha256 TEXT NOT NULL,authority_json TEXT,message_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,baseline_json TEXT,verified_at TEXT,verification_json TEXT,continuation_json TEXT);
CREATE TABLE continuation_plans(task_id TEXT PRIMARY KEY,plan_json TEXT NOT NULL);
`, `ALTER TABLE requests ADD COLUMN delegate_journal_json TEXT;`];
export function openStore(projectRoot:string):BridgeStore {
  const root=realpathSync(projectRoot),dir=join(root,'.session-bridge');
  const info=lstatSync(dir);
  if(info.isSymbolicLink() || !info.isDirectory())throw new BridgeError('unsafe_state_dir','Invalid private state directory','Run init in a real project directory');
  const config=JSON.parse(readFileSync(join(dir,'project.json'),'utf8')) as {protocol_version:number;project_id:string};
  if(config.protocol_version!==1 || !config.project_id)throw new BridgeError('invalid_project','Incompatible project config','Use the matching bridge version');
  const path=join(dir,'bridge.sqlite');
  if(existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))throw new BridgeError('unsafe_database','Database must be a regular private file','Remove the unsafe link after preserving your data');
  const db=new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const version=Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if(version>migrations.length)throw new BridgeError('future_schema','Database was created by a newer version','Upgrade SessionBridge; do not downgrade the database');
    chmodSync(dir,0o700);chmodSync(path,0o600);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const store:BridgeStore={db,project_id:config.project_id,root,close:()=>db.close()};
    transaction(store,()=>{const current=Number(db.prepare('PRAGMA user_version').get()?.user_version);for(let i=current;i<migrations.length;i++)db.exec(migrations[i]!);db.exec(`PRAGMA user_version=${migrations.length}`);});
    return store;
  }catch(error){db.close();throw error;}
}
export function transaction<T>(store:BridgeStore,fn:()=>T):T{store.db.exec('BEGIN IMMEDIATE');try{const result=fn();store.db.exec('COMMIT');return result;}catch(error){store.db.exec('ROLLBACK');throw error;}}
export function appendEvent(store:BridgeStore,kind:string,subjectId:string,payload:unknown,createdAt=new Date().toISOString()):number{return Number(store.db.prepare('INSERT INTO events(kind,subject_id,payload_json,created_at) VALUES (?,?,?,?)').run(kind,subjectId,JSON.stringify(payload),createdAt).lastInsertRowid);}
