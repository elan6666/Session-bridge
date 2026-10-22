import { randomUUID } from 'node:crypto';
import type { BindingRecord } from '../../src/protocol/types.js';
import type { BridgeStore } from '../../src/core/database.js';
import { identity } from './fixtures.js';
export function binding(store:BridgeStore,patch:Partial<BindingRecord>={}):BindingRecord{return {binding_id:randomUUID(),identity:{...identity,project_id:store.project_id},alias:'监督',mode:'attached',capabilities:[],endpoint_ref:'private:reference',expires_at:'2099-01-01T00:00:00Z',active:true,...patch};}
