import { dirname,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { locateCore } from '../locate.mjs';
const root=locateCore(dirname(dirname(fileURLToPath(import.meta.url))));
try{const {claudeSessionStart}=await import(pathToFileURL(join(root,'dist/src/adapters/claude/hook.js')).href);await claudeSessionStart(JSON.parse(readFileSync(0,'utf8')));}catch{process.stderr.write('会桥：原生会话连接未完成，请运行 doctor。\n');process.exitCode=1;}
