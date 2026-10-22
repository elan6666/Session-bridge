import { createHash } from 'node:crypto';
import type { SessionIdentity } from './types.js';
function normalize(value:unknown):unknown {
  if(value===null || typeof value==='string' || typeof value==='boolean')return value;
  if(typeof value==='number' && Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(normalize);
  if(typeof value==='object' && value && Object.getPrototypeOf(value)===Object.prototype){return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize((value as Record<string,unknown>)[key])]))}
  throw new TypeError('Only finite JSON values can be hashed');
}
export function canonical(value:unknown):string {return JSON.stringify(normalize(value));}
export function digest(value:unknown):string {return createHash('sha256').update(canonical(value),'utf8').digest('hex');}
export function sessionKey(identity:SessionIdentity):string {return digest(identity);}
