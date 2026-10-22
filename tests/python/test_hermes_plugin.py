import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('sessionbridge_plugin', Path(__file__).resolve().parents[2] / 'plugins/hermes/sessionbridge_plugin.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Native:
    def __init__(self):
        self.calls = []
        self.running = True
        self.permission = True
        self.job_running = True
    def inject_message(self, content, role='user', *, session_key=None, origin=None):
        self.calls.append((content, session_key, origin))
        return True
class PluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.native = Native()
    def plugin(self, surface='cli', safe_idle=False):
        p = module.BridgePlugin(self.native, root=self.tmp.name, session_key='durable-key', generation='g1', surface=surface, permission=lambda:self.native.permission, idle=lambda:not self.native.running, safe_idle=safe_idle)
        self.addCleanup(p.close)
        return p
    def envelope(self, mid='message-one'):
        return {'message_id':mid,'target':{'native_session_id':'durable-key','runtime_generation':'g1','harness':'hermes'},'body':{'text':'外部任务 $(touch NEVER)','artifacts':[]}}
    def test_busy_never_calls_inject(self):
        p = self.plugin(safe_idle=True)
        self.assertEqual(p.on_delivery(self.envelope())['state'], 'uncertain')
        p.on_idle('durable-key')
        self.assertEqual(self.native.calls, [])
        self.native.running = False
        p.on_idle('durable-key')
        self.assertEqual(len(self.native.calls), 1)
        p.on_idle('durable-key')
        self.assertEqual(len(self.native.calls), 1)
    def test_durable_key_not_ui_id(self):
        p = self.plugin(surface='tui')
        p.on_delivery(self.envelope())
        self.assertEqual(self.native.calls[0][1], 'durable-key')
        wrong = self.envelope('other'); wrong['target']['native_session_id']='ui-ephemeral'
        self.assertEqual(p.on_delivery(wrong)['state'], 'refused')
        self.assertEqual(len(self.native.calls), 1)
    def test_permission_missing_blocks(self):
        p = self.plugin(surface='tui'); self.native.permission=False
        self.assertEqual(p.on_delivery(self.envelope())['state'],'refused')
        self.assertEqual(self.native.calls, [])
    def test_disconnect_leaves_job_running(self):
        p = self.plugin(safe_idle=True); p.on_delivery(self.envelope()); p.close()
        self.native.running=False; p.on_idle('durable-key')
        self.assertTrue(self.native.job_running)
        self.assertEqual(self.native.calls, [])
    def test_no_idle_proof_blocks_cli(self):
        p = self.plugin(); self.native.running=False
        self.assertEqual(p.on_delivery(self.envelope())['state'],'refused')
        self.assertEqual(self.native.calls, [])
    def test_gateway_schedule_is_not_admission_and_exact_native_input_confirms(self):
        p=self.plugin(surface='gateway-tui'); envelope=self.envelope()
        self.assertEqual(p.on_delivery(envelope)['state'],'uncertain')
        self.assertEqual(len(self.native.calls),1)
        self.assertIsNone(p.observe_input('other',module.PREFIX+module.canonical(envelope)))
        altered=self.envelope();altered['body']['text']='altered'
        self.assertIsNone(p.observe_input('durable-key',module.PREFIX+module.canonical(altered)))
        self.assertEqual(p.observe_input('durable-key',module.PREFIX+module.canonical(envelope)),envelope)
        self.assertEqual(p.on_delivery(envelope)['state'],'confirmed')
        self.assertEqual(len(self.native.calls),1)
    def test_gateway_permission_withdrawal_prevents_observation(self):
        p=self.plugin(surface='gateway-tui'); envelope=self.envelope();p.on_delivery(envelope)
        self.native.permission=False
        self.assertIsNone(p.observe_input('durable-key',module.PREFIX+module.canonical(envelope)))
class RegistrationTests(unittest.TestCase):
    def test_turn_end_keeps_connection_and_finalize_closes_only_exact_session(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root)/'.session-bridge';directory.mkdir();(directory/'project.json').write_text('{}')
            class Context:
                def __init__(self):self.hooks={};self.commands={}
                def register_hook(self,n,fn):self.hooks[n]=fn
                def register_tool(self,*a,**k):pass
                def register_command(self,n,fn,**k):self.commands[n]=fn
                def on_unload(self,*a):pass
                def _gateway_injection_allowed(self):return True
            instances=[]
            class Connection:
                def __init__(self,ctx,root,key,surface):self.closed=False;self.stored_id='stored-'+key;instances.append(self)
                def close(self):self.closed=True
            native=(object(),object(),SimpleNamespace(platform='tui',cwd=root))
            with patch.object(module,'gateway_session',return_value=native),patch.object(module,'NativeConnection',Connection):
                ctx=Context();module.register(ctx)
                ctx.commands['sessionbridge-connect']('',session_key='one')
                ctx.commands['sessionbridge-connect']('',session_key='two')
                ctx.hooks['on_session_end'](session_id='stored-one',turn_id='turn-finished')
                ctx.hooks['on_session_finalize'](session_id='unknown')
                self.assertFalse(any(c.closed for c in instances))
                ctx.hooks['on_session_reset'](session_id='new-session',old_session_id='stored-one')
                self.assertTrue(instances[0].closed);self.assertFalse(instances[1].closed)
                ctx.hooks['on_session_finalize'](session_id='stored-two')
                self.assertTrue(instances[1].closed)
    def test_lifecycle_uses_native_hooks_not_plugin_event_topics(self):
        class Context:
            def __init__(self):self.hooks={};self.topics={};self.tools={}
            def register_hook(self,name,callback):self.hooks[name]=callback
            def subscribe(self,name,callback):self.topics[name]=callback
            def register_tool(self,name,*args,**kwargs):self.tools[name]=args
            def register_command(self,*args,**kwargs):pass
            def on_unload(self,*args):pass
        ctx=Context();module.register(ctx)
        self.assertEqual(set(ctx.hooks),{'on_session_reset','on_session_end','on_session_finalize','pre_llm_call'})
        self.assertEqual(ctx.topics,{})
        self.assertIn('sessionbridge_request',ctx.tools)
if __name__ == '__main__': unittest.main()

