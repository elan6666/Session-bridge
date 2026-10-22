import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionIdentity } from '../../src/protocol/types.js';
export const identity:SessionIdentity={harness:'codex',host_id:'local',profile_id:'test',native_session_id:'AbC',project_id:'project-1',runtime_generation:'generation-1'};
export function tempRoot(){const root=mkdtempSync(join(tmpdir(),'sessionbridge-test-'));return {root,cleanup:()=>rmSync(root,{recursive:true,force:true})};}
