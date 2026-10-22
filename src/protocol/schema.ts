import { z } from 'zod';
import type { Envelope } from './types.js';
import { digest } from './canonical.js';
import { BridgeError } from './errors.js';
export const nonempty=z.string().min(1);
export const timestamp=z.iso.datetime({offset:true});
export const sessionSchema=z.strictObject({harness:nonempty,host_id:nonempty,profile_id:nonempty,native_session_id:nonempty,project_id:nonempty,runtime_generation:nonempty});
export const artifactSchema=z.strictObject({project_id:nonempty,relative_path:nonempty,sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const authoritySchema=z.strictObject({workflow:z.enum(['standalone','byte']),handoff_id:nonempty.nullable(),epoch:z.number().int().nonnegative(),owner_session_key:nonempty,scope_digest:nonempty});
export const taskInputSchema=z.strictObject({source:sessionSchema,target:sessionSchema,goal:nonempty,acceptance:z.array(nonempty).min(1),read_paths:z.array(nonempty),write_paths:z.array(nonempty),return_to:sessionSchema,authority:authoritySchema,deadline_at:timestamp});
export const envelopeSchema=z.strictObject({protocol_version:z.literal(1),message_id:nonempty,task_id:nonempty,handoff_id:nonempty.nullable(),authority_epoch:z.number().int().nonnegative(),sender:sessionSchema,target:sessionSchema,kind:z.enum(['task','accepted','progress','needs_input','result','return','main_ack','supervision','verification_ready']),body:z.strictObject({text:z.string(),artifacts:z.array(artifactSchema)}),body_sha256:z.string().regex(/^[a-f0-9]{64}$/),created_at:timestamp,expires_at:timestamp,causation_id:nonempty.nullable(),correlation_id:nonempty});
export function parseEnvelope(input:unknown):Envelope {
  const result=envelopeSchema.safeParse(input);
  if(!result.success)throw new BridgeError('invalid_envelope','Invalid protocol 1 envelope','Use protocol 1 and the documented schema');
  if(digest(result.data.body)!==result.data.body_sha256)throw new BridgeError('digest_mismatch','Message content digest does not match','Rebuild the envelope with the original body');
  if(Date.parse(result.data.expires_at)<=Date.parse(result.data.created_at))throw new BridgeError('invalid_expiry','Message expiry must follow creation','Supply a future expiry');
  return result.data;
}

export const requestOperations={assign_roles:'configure_roles',delegate:'delegate_task',supervise:'request_supervision',status:'get_task_status',return:'return_to_main',recover:'recover_delivery',cancel_pending:'cancel_pending'} as const;
