import type { RunProof } from './runs.js';
import { digest } from '../protocol/canonical.js';
export function runEventId(leaseId:string,proof:RunProof):string{return digest({lease_id:leaseId,identity:proof.identity,status:proof.status,exit_code:proof.exit_code,artifacts:proof.artifacts});}
