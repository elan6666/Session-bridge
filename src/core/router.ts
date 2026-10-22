import type { BindingRecord, SessionIdentity } from '../protocol/types.js';
import type { NativeRoute } from '../adapters/contract.js';
export interface RouteContext {source:SessionIdentity;target:BindingRecord;native?:NativeRoute;adapter_id:string|null}
export type RouteDecision={kind:'native'|'adapter'|'blocked';route_id:string;reason?:string};
export function chooseRoute(context:RouteContext):RouteDecision {
 if(context.source.project_id!==context.target.identity.project_id || context.source.host_id!==context.target.identity.host_id)return {kind:'blocked',route_id:'blocked',reason:'Cross-project or cross-machine route is outside this scope'};
 if(context.native?.tool_name && context.native.evidence && context.source.harness===context.target.identity.harness)return {kind:'native',route_id:'native:'+context.native.tool_name};
 if(context.adapter_id && context.target.mode!=='manual')return {kind:'adapter',route_id:'adapter:'+context.adapter_id};
 return {kind:'blocked',route_id:'blocked',reason:'No reachable native tool or registered adapter'};
}
