import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryService } from '../../src/core/delivery.js';
import { deliveryLab } from '../helpers/delivery-lab.js';
test('native_and_plugin_share_one_delivery',async t=>{const f=await deliveryLab(t);let native=0;const service=new DeliveryService(f.store,f.registry,{native:{tool_name:'actual-host-SendMessage',evidence:'isolated native capability fixture',deliver:async()=>{native++;return {state:'confirmed',native_receipt:'native-one'};}}});await service.send(f.actor,f.envelope);await f.service.send(f.actor,f.envelope);assert.equal(native,1);assert.equal(f.adapter.enqueueCount,0);});
