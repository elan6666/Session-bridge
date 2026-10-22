import { createPluginAdapter,type PluginBindingClient } from '../plugin-client.js';
export function createPiAdapter({bindingClient}:{bindingClient:PluginBindingClient}){return createPluginAdapter('pi',bindingClient);}
