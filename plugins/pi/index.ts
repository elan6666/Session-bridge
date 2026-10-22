import { dirname,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// Native loaders transpile this wrapper; only the installed local runtime is imported.
// @ts-expect-error shipped JavaScript locator has no TypeScript declaration
import { locateCore } from './locate.mjs';
export default async function(pi:ExtensionAPI):Promise<void>{const core=locateCore(dirname(fileURLToPath(import.meta.url)));const extension=await import(pathToFileURL(join(core,'dist/src/adapters/pi/extension.js')).href);extension.default(pi);}
