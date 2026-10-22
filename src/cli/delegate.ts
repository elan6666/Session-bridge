import type { Actor, TaskInput } from '../protocol/types.js';
import type { TaskService } from '../core/tasks.js';
export async function delegateTask(tasks:TaskService,actor:Actor,input:TaskInput){return tasks.create(actor,input);}
