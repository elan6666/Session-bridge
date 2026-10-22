import type { Actor, BindingRecord, Capability, DeliveryOutcome, EnrollmentPrincipal, Envelope, NativeContextProof, Observation } from '../protocol/types.js';
export interface CapabilityReport {harness:string;version:string|null;modes:Record<string,{supported:boolean;evidence:string|null;constraints:string[]}>;capabilities:Capability[]}
export interface EnrollmentContext {setup:EnrollmentPrincipal;native_proof:NativeContextProof}
export interface Adapter {probe():Promise<CapabilityReport>;discover():Promise<BindingRecord[]>;enroll(context:EnrollmentContext):Promise<BindingRecord>;deliver(envelope:Envelope):Promise<DeliveryOutcome>;reconcile(envelope:Envelope):Promise<Observation[]>;observe(binding:BindingRecord,signal:AbortSignal):AsyncIterable<Observation>;disconnect(bindingId:string):Promise<void>}
export interface NativeRoute {tool_name:string;evidence:string;deliver:(actor:Actor,envelope:Envelope)=>Promise<DeliveryOutcome>;reconcile?:(envelope:Envelope)=>Promise<Observation[]>}
