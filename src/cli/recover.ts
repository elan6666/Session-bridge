import type { Actor } from '../protocol/types.js';
import type { DeliveryService } from '../core/delivery.js';
export async function recoverDelivery(deliveries:DeliveryService,actor:Actor,messageId:string){return deliveries.recover(actor,messageId);}
