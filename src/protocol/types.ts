export interface SessionIdentity { harness:string; host_id:string; profile_id:string; native_session_id:string; project_id:string; runtime_generation:string }
export type Mode = 'native'|'attached'|'hot_attached'|'managed'|'manual';
export interface Capability { name:string; supported:boolean; evidence:string|null; constraints:string[] }
export interface Actor { session:SessionIdentity; scope:{project_id:string; task_ids:string[]; operations:string[]}; binding_id:string }
export interface EnrollmentPrincipal { kind:'local_setup'; project_id:string; capability_ref:string; expires_at:string }
export interface NativeContextProof { binding_id:string; challenge_id:string; response:string; identity:SessionIdentity; expires_at:string }
export interface ArtifactRef { project_id:string; relative_path:string; sha256:string }
export interface Envelope { protocol_version:1; message_id:string; task_id:string; handoff_id:string|null; authority_epoch:number; sender:SessionIdentity; target:SessionIdentity; kind:'task'|'accepted'|'progress'|'needs_input'|'result'|'return'|'main_ack'|'supervision'|'verification_ready'; body:{text:string; artifacts:ArtifactRef[]}; body_sha256:string; created_at:string; expires_at:string; causation_id:string|null; correlation_id:string }
export interface AuthorityRef { workflow:'standalone'|'byte'; handoff_id:string|null; epoch:number; owner_session_key:string; scope_digest:string }
export interface TaskInput { source:SessionIdentity; target:SessionIdentity; goal:string; acceptance:string[]; read_paths:string[]; write_paths:string[]; return_to:SessionIdentity; authority:AuthorityRef; deadline_at:string }
export type DeliveryOutcome = {state:'confirmed';native_receipt:string}|{state:'uncertain'|'refused';reason:string};
export interface Observation { state:'queued'|'accepted'|'running'|'completed'|'unknown'; message_id:string; session:SessionIdentity; native_receipt:string|null; artifacts:ArtifactRef[] }
export type TaskState = 'created'|'ready'|'accepted'|'running'|'result_reported'|'verified'|'needs_input'|'failed'|'cancel_requested'|'cancelled';
export interface TaskRecord { task_id:string; state:TaskState; input:TaskInput; input_sha256:string; event_seq:number }
export type DeliveryState = 'prepared'|'sending'|'uncertain'|'transport_confirmed'|'receiver_accepted'|'refused'|'cancelled';
export interface DeliveryRecord { message_id:string; state:DeliveryState; envelope:Envelope; input_sha256:string; event_seq:number; native_receipt:string|null; reason:string|null }
export interface BindingRecord { binding_id:string; identity:SessionIdentity; alias:string; mode:Mode; capabilities:Capability[]; endpoint_ref:string; expires_at:string; active:boolean }
export interface SessionSelector { query:string; harness?:string; project_id?:string; profile_id?:string }
export interface Clock { now():Date }
export const systemClock:Clock={now:()=>new Date()};
export interface CliIO { stdin:string; stdout:(text:string)=>void; stderr:(text:string)=>void; isTTY:boolean }

export type SessionTarget = 'current'|SessionSelector|{role:'supervisor'};
export interface RunIdentity {run_id:string;pid:number;started_at:string;command_sha256:string;root:string;source_commit:string;config_sha256:string}
interface RequestBase {request_id:string;original_text?:string;dry_run?:boolean}
export type BridgeRequest =
 | (RequestBase & {operation:'assign_roles';main:SessionTarget;supervisor:SessionTarget})
 | (RequestBase & {operation:'delegate';target:SessionTarget;goal:string;acceptance:string[];read_paths:string[];write_paths:string[];deadline_at:string})
 | (RequestBase & {operation:'supervise';task_id:string;run:RunIdentity;supervisor:SessionTarget;interval_seconds:number;deadline_at:string;repair_paths:string[]})
 | (RequestBase & {operation:'status';task_id?:string;for_request?:string})
 | (RequestBase & {operation:'return';task_id:string;summary?:string})
 | (RequestBase & {operation:'recover';message_id:string})
 | (RequestBase & {operation:'cancel_pending';task_id:string;stop_supervision?:boolean});
export interface RoleAssignment {main:SessionIdentity;supervisor:SessionIdentity;updated_at:string}
export type SessionCandidate = Omit<BindingRecord,'endpoint_ref'>;
export type RequestResult =
 | {state:'executed';operation:BridgeRequest['operation'];result:unknown;original_text_sha256:string|null}
 | {state:'needs_selection';slot:string;candidates:SessionCandidate[]}
 | {state:'needs_input';fields:string[];recovery:string}
 | {state:'blocked';reason:string;recovery:string;task_id?:string;message_id?:string};

export interface NativeProcessOwner {pid:number;started_at:string;executable:string}
