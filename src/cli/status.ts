import type { Actor } from '../protocol/types.js';
import type { TaskService } from '../core/tasks.js';
export function taskStatus(tasks:TaskService,actor:Actor,taskId:string){return tasks.get(actor,taskId);}
