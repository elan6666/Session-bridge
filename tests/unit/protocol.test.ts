import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from '../../src/protocol/schema.js';
import { sessionKey } from '../../src/protocol/canonical.js';
import { runCli } from '../../src/cli/main.js';
import { identity } from '../helpers/fixtures.js';
test('rejects_unknown_protocol',async()=>{assert.throws(()=>parseEnvelope({protocol_version:2}));assert.equal(await runCli(['bogus'],{stdin:'',stdout:()=>{},stderr:()=>{},isTTY:false}),2);});
test('keeps_native_id_case',()=>assert.notEqual(sessionKey(identity),sessionKey({...identity,native_session_id:'abc'})));
