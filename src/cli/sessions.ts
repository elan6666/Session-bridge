import type { SessionSelector } from '../protocol/types.js';
import type { BindingService } from '../core/bindings.js';
export async function listSessions(service:BindingService,selector:SessionSelector){return (await service.resolve(selector)).map(({endpoint_ref:_private,...record})=>record);}
