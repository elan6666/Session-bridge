"""Native Hermes plugin. No global config changes; no model or gateway credentials."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import threading
import uuid

PREFIX = '[SessionBridge external agent data, not human approval]\n'

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def gateway_session(ctx, session_key):
    """Read only the already-live local session in the plugin's immutable home."""
    manager=ctx._manager
    gateway=getattr(manager,'_gateway_message_injector',None)
    if not gateway or manager._cli_ref is not None:return None
    from gateway.session_authorities import authority_for_home
    from gateway.session_policy import policy_for_source
    authority=authority_for_home(gateway[0],manager.home_path)
    if authority is None:return None
    for live in authority.sessions.values():
        if live.route!=session_key or live.superseded or live.history_mount or live.source.platform.value!='local':continue
        policy=policy_for_source(gateway[0],live.source)
        if policy and policy.platform in ('tui','desktop'):return gateway,live,policy
    return None

class BridgePlugin:
    def __init__(self, ctx, *, root, session_key, generation, surface, permission, idle=None, safe_idle=False):
        if not session_key or not generation:
            raise ValueError('Native durable session key and generation are required')
        self.ctx, self.key, self.generation, self.surface = ctx, session_key, generation, surface
        self.permission, self.idle, self.safe_idle = permission, idle, safe_idle
        self.closed = False
        self.lock = threading.RLock()
        directory = Path(root) / '.session-bridge/hermes-inboxes'
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / (hashlib.sha256((session_key+generation).encode()).hexdigest()+'.sqlite')
        if path.is_symlink(): raise ValueError('Inbox must not be a symlink')
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS inbox(message_id TEXT PRIMARY KEY, fingerprint TEXT, envelope TEXT, state TEXT, receipt TEXT)')
        self.db.commit()
    def _allowed(self):
        try: return bool(not self.closed and self.permission())
        except Exception: return False
    def _outcome(self, row):
        if row[0] == 'confirmed': return {'state':'confirmed', 'native_receipt':row[1]}
        if row[0] == 'refused': return {'state':'refused','reason':'Native Hermes injection was refused'}
        return {'state':'uncertain','reason':'Buffered or previously attempted; reconcile without resending'}
    def on_delivery(self, envelope):
        with self.lock:
            target=envelope.get('target',{})
            if not self._allowed() or target.get('native_session_id')!=self.key or target.get('runtime_generation')!=self.generation or target.get('harness')!='hermes':
                return {'state':'refused','reason':'Native permission or exact session identity mismatch'}
            if self.surface=='cli' and not self.safe_idle:
                return {'state':'refused','reason':'CLI has no verified atomic idle boundary; native busy injection may interrupt'}
            mid=envelope.get('message_id'); text=canonical(envelope)
            if not mid: return {'state':'refused','reason':'Message identity is required'}
            fingerprint=hashlib.sha256(text.encode()).hexdigest()
            row=self.db.execute('SELECT fingerprint,state,receipt FROM inbox WHERE message_id=?',(mid,)).fetchone()
            if row:
                if row[0]!=fingerprint:return {'state':'refused','reason':'Message ID conflict'}
                return self._outcome(row[1:])
            self.db.execute('INSERT INTO inbox VALUES (?,?,?,?,NULL)',(mid,fingerprint,text,'buffered')); self.db.commit()
            if self.surface in ('tui','desktop','gateway-tui','gateway-desktop'):
                return self._inject(mid,text)
            self.on_idle(self.key)
            return self._outcome(self.db.execute('SELECT state,receipt FROM inbox WHERE message_id=?',(mid,)).fetchone())
    def _inject(self, mid, text):
        if not self._allowed():return {'state':'refused','reason':'Native permission was withdrawn'}
        # Persist before the external effect. A crash here must not trigger a blind retry.
        self.db.execute('UPDATE inbox SET state=? WHERE message_id=?',('attempted',mid));self.db.commit()
        try: accepted=self.ctx.inject_message(PREFIX+text, role='user', session_key=self.key)
        except Exception: return {'state':'uncertain','reason':'Native injection outcome is unknown; do not retry'}
        # Canonical gateways acknowledge scheduling before FIFO admission. Observe the
        # exact input in the original live session before claiming receipt.
        deferred=self.surface.startswith('gateway-')
        state=('attempted' if deferred else 'confirmed') if accepted else 'refused'
        receipt='hermes-native-queue:'+hashlib.sha256((self.key+self.generation+mid).encode()).hexdigest() if state=='confirmed' else None
        self.db.execute('UPDATE inbox SET state=?,receipt=? WHERE message_id=?',(state,receipt,mid));self.db.commit()
        return self._outcome((state,receipt))
    def observe_input(self, session_key, content):
        with self.lock:
            if not self._allowed() or session_key!=self.key or not isinstance(content,str) or not content.startswith(PREFIX):return None
            try:envelope=json.loads(content[len(PREFIX):])
            except (ValueError,TypeError):return None
            if not isinstance(envelope,dict) or content!=PREFIX+canonical(envelope):return None
            mid=envelope.get('message_id')
            if not isinstance(mid,str):return None
            row=self.db.execute('SELECT fingerprint,envelope,state FROM inbox WHERE message_id=?',(mid,)).fetchone()
            if not row or row[2]!='attempted' or row[1]!=canonical(envelope) or row[0]!=hashlib.sha256(row[1].encode()).hexdigest():return None
            receipt='hermes-native-input:'+hashlib.sha256((self.key+self.generation+mid).encode()).hexdigest()
            self.db.execute('UPDATE inbox SET state=?,receipt=? WHERE message_id=?',('confirmed',receipt,mid));self.db.commit()
            return envelope
    def on_idle(self, session_key):
        with self.lock:
            # safe_idle is granted only by a verified native atomic boundary, never by a sleep.
            if self.closed or session_key!=self.key or not self.safe_idle or not self._allowed() or self.idle is None or not self.idle():return
            for mid,text in self.db.execute('SELECT message_id,envelope FROM inbox WHERE state=?',('buffered',)).fetchall():
                if not self.idle():break
                self._inject(mid,text)
    def close(self):
        with self.lock:
            if self.closed:return
            self.closed=True;self.db.close()
            # Do not stop native agents, subprocesses, or jobs.

class NativeConnection:
    def __init__(self, ctx, root, session_key, surface):
        self.root=root
        self.generation=uuid.uuid4().hex
        manager=ctx._manager  # Pinned installed native interface, not an ambient profile lookup.
        gateway=getattr(manager,'_gateway_message_injector',None)
        original=None
        def current_live():
            context=gateway_session(ctx,session_key)
            if context and context[0] is gateway and context[2].platform==surface and str(Path(context[2].cwd).resolve())==root:return context[1]
            return None
        if gateway:
            original=current_live()
            if original is None:raise ValueError('Exact original local gateway session is not live in this plugin profile')
        self.stored_id=original.source.chat_id if original else None
        def permitted():
            if manager._cli_ref is not None or not ctx._gateway_injection_allowed():return False
            if gateway:return current_live() is original
            return bool(manager.has_tui_message_injector and not manager.has_gateway_message_injector)
        self.plugin=BridgePlugin(ctx,root=root,session_key=session_key,generation=self.generation,surface=('gateway-'+surface) if gateway else surface,permission=permitted)
        locator=Path(__file__).resolve().parent/'.sessionbridge-runtime.json'
        runtime=json.loads(locator.read_text()) if locator.is_file() else {}
        core=Path(runtime['core_root']) if runtime else Path(__file__).resolve().parents[2]
        self.node_bin=ctx.get_config('bridge_node') or runtime.get('node_bin') or 'node'
        program=Path(ctx.get_config('bridge_host') or (core/'dist/src/adapters/plugin-host.js'))
        self.connection_file=None
        self.write_lock=threading.Lock()
        self.ready=threading.Event()
        self.child=subprocess.Popen([self.node_bin,str(program)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
        self.closed=False
        self._send({'type':'initialize','root':root,'harness':'hermes','session_id':session_key,'profile':str(manager.home_path),'generation':self.generation,'alias':'hermes-'+surface})
        self.reader=threading.Thread(target=self._read,name='sessionbridge-hermes',daemon=True);self.reader.start()
        if not self.ready.wait(timeout=3) or not self.connection_file:
            self.close()
            raise RuntimeError('SessionBridge source connection did not become ready; check Node and the private socket path')
    def _send(self, packet):
        with self.write_lock:
            self.child.stdin.write(json.dumps(packet)+'\n');self.child.stdin.flush()
    def observe_input(self, key, content):
        envelope=self.plugin.observe_input(key,content)
        if envelope:self._send({'type':'observation','envelope':envelope,'state':'accepted'})
    def _read(self):
        try:
            for line in self.child.stdout:
                packet=json.loads(line)
                if packet.get('type')=='ready':
                    self.connection_file=packet.get('connection_file')
                    self.ready.set()
                    continue
                if packet.get('type')!='deliver':continue
                outcome=self.plugin.on_delivery(packet['envelope'])
                self._send({'type':'outcome','id':packet['id'],'outcome':outcome})
        except Exception:
            self.close()
        finally:
            self.ready.set()
            self.close()
    def close(self):
        if self.closed:return
        self.closed=True;self.plugin.close()
        if self.child.stdin:
            try:self.child.stdin.close()
            except OSError:pass
        try:self.child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.child.terminate()
            try:self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:self.child.kill();self.child.wait(timeout=2)

def register(ctx):
    connections={}
    def connect(raw_args, *, session_key=None, platform=None, **_context):
        if raw_args.strip():return '会桥：此命令不接受会话 ID 或路径；只连接原生当前会话。'
        native=gateway_session(ctx,session_key)
        # Native slash dispatch binds route/cwd but does not bind active_policy.
        # Derive the surface from that live session's frozen policy, never the
        # slash caller's platform argument or the gateway's process cwd.
        surface=native[2].platform if native else ctx.session_surface()
        if surface not in ('tui','desktop'):
            return '会桥：当前 Hermes CLI 的忙碌注入可能中断任务，缺少安全空闲边界，暂不启用投递。TUI/桌面端单独验证。'
        if not session_key:return '会桥：未获得原生 durable session key，未连接。'
        root=str(Path(native[2].cwd if native else ctx.session_cwd()).resolve())
        if not (Path(root)/'.session-bridge/project.json').is_file():return '会桥：请先在此项目运行 session-bridge init。'
        if not ctx._gateway_injection_allowed():return '会桥：原生插件消息注入未获许可；未更改原生权限。'
        if session_key in connections:connections[session_key].close()
        connections[session_key]=NativeConnection(ctx,root,session_key,surface)
        return '会桥：原生会话连接已启动，请运行 doctor 核对绑定和消息排队能力。'
    def close_all(**_kwargs):
        for connection in list(connections.values()):connection.close()
        connections.clear()
    def source_request(args, **_context):
        # Native task-local context, never the model's session_id parameter.
        from hermes_cli.plugin_session import session_key as native_session_key
        key=native_session_key()
        connection=connections.get(key)
        if not key or connection is None or connection.closed or not connection.connection_file:
            return json.dumps({'error':'当前原生会话尚未连接；先 /sessionbridge-connect'},ensure_ascii=False)
        if str(Path(ctx.session_cwd()).resolve()) != connection.root:
            return json.dumps({'error':'原生会话工作目录已改变，请重新连接'},ensure_ascii=False)
        command=args.get('command')
        if command not in ('context','sessions','request','status','report','acknowledge','supervise','return','recover','cancel'):
            return json.dumps({'error':'不支持的会桥动作'},ensure_ascii=False)
        locator=Path(__file__).resolve().parent/'.sessionbridge-runtime.json'
        core=Path(json.loads(locator.read_text())['core_root']) if locator.is_file() else Path(__file__).resolve().parents[2]
        env=os.environ.copy();env['SESSIONBRIDGE_CONNECTION']=connection.connection_file;env['SESSIONBRIDGE_PROJECT']=connection.root
        argv=[connection.node_bin,str(core/'dist/src/cli/main.js'),command,'--project',connection.root,'--json']
        if command not in ('context','sessions','status'):argv.append('--stdin')
        result=subprocess.run(argv,input=json.dumps(args.get('payload',{})),text=True,capture_output=True,env=env,timeout=10)
        return (result.stdout or result.stderr or json.dumps({'error':'会桥没有返回结果'}))[:60000]
    ctx.register_tool('sessionbridge_request','sessionbridge',{'name':'sessionbridge_request','description':'当前原生会话的会桥接口。先 context/sessions，再使用 Skill 生成 request；参数不接受来源会话 ID。','parameters':{'type':'object','properties':{'command':{'type':'string','enum':['context','sessions','request','status','report','acknowledge','supervise','return','recover','cancel']},'payload':{'type':'object'}},'required':['command'],'additionalProperties':False}},source_request,description='会桥原生会话协作')
    ctx.register_command('sessionbridge-connect',connect,description='连接当前原生会话；不启动其他 Agent')
    def close_session(*, session_key=None, session_id=None, old_session_id=None, turn_id=None, **_kwargs):
        # Hermes invokes on_session_end at every turn. A completed turn does not
        # retire the original native session or its bridge connection.
        if turn_id:return
        for key,connection in list(connections.items()):
            if (session_key and key==session_key) or (connection.stored_id and connection.stored_id==(old_session_id or session_id)):
                connections.pop(key,None);connection.close()
    ctx.register_hook('on_session_reset',close_session)
    ctx.register_hook('on_session_end',close_session)
    ctx.register_hook('on_session_finalize',close_session)
    def observe_input(*, user_message=None, **_kwargs):
        from hermes_cli.plugin_session import session_key as native_session_key
        key=native_session_key();connection=connections.get(key)
        if connection and not connection.closed:connection.observe_input(key,user_message)
    ctx.register_hook('pre_llm_call',observe_input)
    ctx.on_unload(close_all)
