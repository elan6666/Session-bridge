import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHermesAdapter } from '../../src/adapters/hermes/adapter.js';
import { deliveryLab } from '../helpers/delivery-lab.js';
test('hermes_reports_cli_idle_boundary_blocked',async()=>{const adapter=createHermesAdapter({bindingClient:{list:async()=>[],call:async()=>{throw new Error('Not connected');}}});assert.equal((await adapter.probe()).modes.cli?.supported,false);});
test('hermes_never_falls_back_to_wrong_native_key',async t=>{const lab=await deliveryLab(t);let calls=0;const adapter=createHermesAdapter({bindingClient:{list:async()=>[],call:async()=>{calls++;}}});assert.equal((await adapter.deliver({...lab.envelope,target:{...lab.envelope.target,harness:'hermes'}})).state,'refused');assert.equal(calls,0);});
