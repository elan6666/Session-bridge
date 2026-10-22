import{test}from'node:test';import assert from'node:assert/strict';import{spawn}from'node:child_process';import{once}from'node:events';import{mkdtempSync,existsSync,lstatSync,rmSync}from'node:fs';import{join,resolve}from'node:path';import{runDaemon}from'../../src/cli/daemon.js';import{deliveryLab}from'../helpers/delivery-lab.js';

test('a_killed_owned_daemon_reclaims_its_refused_socket_and_preserves_state',async t=>{
 const f=await deliveryLab(t),dir=mkdtempSync('/tmp/sb-restart-'),socket=join(dir,'core.sock');const script=`const{runDaemon}=await import(${JSON.stringify('file://'+resolve('dist/src/cli/daemon.js'))});await runDaemon(process.argv[1],process.argv[2]);process.send('ready');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,f.root,socket],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});});
 const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('daemon failed to start')})]);assert.equal(ready[0],'ready');const inode=lstatSync(socket).ino;const ended=once(child,'exit');child.kill('SIGKILL');await ended;assert.equal(existsSync(socket),true);
 const restarted=await runDaemon(f.root,socket,f.registry);t.after(()=>restarted.close());assert.notEqual(lstatSync(socket).ino,inode);assert.equal(f.store.db.prepare('select count(*) n from tasks').get()?.n,1);
});
test('an_unowned_socket_is_never_removed_by_daemon_start',async t=>{
 const f=await deliveryLab(t),dir=mkdtempSync('/tmp/sb-unknown-'),socket=join(dir,'unknown.sock');const{createServer}=await import('node:net');const server=createServer();await new Promise<void>(resolve=>server.listen(socket,resolve));const inode=lstatSync(socket).ino;t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
 await assert.rejects(()=>runDaemon(f.root,socket,f.registry),/daemon|socket|已有|内核/i);assert.equal(lstatSync(socket).ino,inode);
});
test('a_live_project_core_keeps_its_socket_when_a_second_start_is_attempted',async t=>{
 const f=await deliveryLab(t),dir=mkdtempSync('/tmp/sb-live-core-'),socket=join(dir,'core.sock'),first=await runDaemon(f.root,socket,f.registry);t.after(async()=>{await first.close();rmSync(dir,{recursive:true,force:true});});const inode=lstatSync(socket).ino;await assert.rejects(()=>runDaemon(f.root,socket,f.registry),/running|已有|内核/i);assert.equal(lstatSync(socket).ino,inode);
});
