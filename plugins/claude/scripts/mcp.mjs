import { dirname,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { locateCore } from '../locate.mjs';
const root=locateCore(dirname(dirname(fileURLToPath(import.meta.url))));
const {startMcp}=await import(pathToFileURL(join(root,'dist/src/mcp/stdio.js')).href);await startMcp({harness:'claude',argv:process.argv.slice(2)});
