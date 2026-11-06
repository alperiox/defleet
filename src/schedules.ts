import type { Database } from 'bun:sqlite';
import type { Hub } from './hub';
export interface Schedule {id:string;agentId:string;taskId:string|null;kind:'check-in';everyMinutes:number;message:string|null;nextRun:number;untilTaskDone:boolean;endsAt:number|null;createdAt:number;active:boolean;lastFired:number|null;missedCount:number;stoppedReason:string|null}
export interface ScheduleInput {agent:string;task?:string;everyMinutes:number;message?:string|null;untilTaskDone?:boolean;endsAt?:number|null}
export interface SchedulePatch {active?:boolean;everyMinutes?:number;message?:string|null;untilTaskDone?:boolean;endsAt?:number|null}
const MINUTE=60000,ONLINE=45000;
const dto=(r:any):Schedule=>({id:r.id,agentId:r.agent_id,taskId:r.task_id,kind:r.kind,everyMinutes:r.every_minutes,message:r.message,nextRun:r.next_run,untilTaskDone:!!r.until_task_done,endsAt:r.ends_at,createdAt:r.created_at,active:!!r.active,lastFired:r.last_fired,missedCount:r.missed_count,stoppedReason:r.stopped_reason});
export function scheduleStore(db:Database){
 db.run(`CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,task_id TEXT,kind TEXT NOT NULL DEFAULT 'check-in' CHECK(kind='check-in'),
 every_minutes INTEGER NOT NULL CHECK(typeof(every_minutes)='integer' AND every_minutes BETWEEN 5 AND 1440),message TEXT,next_run INTEGER NOT NULL,
 until_task_done INTEGER NOT NULL DEFAULT 1,ends_at INTEGER,created_at INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,
 last_fired INTEGER,missed_count INTEGER NOT NULL DEFAULT 0,stopped_reason TEXT);
 CREATE INDEX IF NOT EXISTS schedules_due ON schedules(active,next_run);
 CREATE TABLE IF NOT EXISTS schedule_events(id INTEGER PRIMARY KEY,schedule_id TEXT NOT NULL,created_at INTEGER NOT NULL,message TEXT NOT NULL,message_id INTEGER);
 CREATE INDEX IF NOT EXISTS schedule_events_schedule ON schedule_events(schedule_id,id);
 CREATE TABLE IF NOT EXISTS checkin_pending(agent_id TEXT PRIMARY KEY,message_id INTEGER NOT NULL);`);
 return{
  scheduleById(id:string):Schedule|null {const r=db.query('SELECT * FROM schedules WHERE id=?').get(id);return r?dto(r):null;},
  listSchedules():Schedule[]{return db.query('SELECT * FROM schedules ORDER BY created_at,id').all().map(dto);},
  scheduleEvents(id:string):{id:number;createdAt:number;message:string;messageId:number|null}[]{return db.query('SELECT id,created_at AS createdAt,message,message_id AS messageId FROM schedule_events WHERE schedule_id=? ORDER BY id DESC LIMIT 50').all(id) as any;},
 };
}
function log(hub:Hub,id:string,at:number,message:string,messageId:number|null=null){hub.store.db.query('INSERT INTO schedule_events(schedule_id,created_at,message,message_id) VALUES (?,?,?,?)').run(id,at,message,messageId);}
function activeAgent(hub:Hub,id:string,now:number){return hub.store.listAgents().find(a=>a.id===id&&(a.expiresAt===null||a.expiresAt>now));}
function unavailable(hub:Hub,s:Schedule,now:number):string|null {
 const a=activeAgent(hub,s.agentId,now);if(!a)return 'agent removed or expired';
 if(hub.isExternal(a)||(hub.store.db.query('SELECT visibility FROM workspaces WHERE id=?').get(a.workspaceId) as any)?.visibility==='private')return 'team agent unavailable';
 if(s.endsAt!==null&&now>=s.endsAt)return 'end time reached';
 if(s.taskId){const task=hub.store.getTask(s.taskId);if(!task)return 'task deleted';if(task.status==='backlog')return 'task in Backlog';if(!hub.canAccessTask(a,task))return 'task no longer visible to agent';if(s.untilTaskDone&&task.status==='done')return 'task done';}
 return null;
}
function validate(input:SchedulePatch,now:number){
 if(input.everyMinutes!==undefined&&(!Number.isInteger(input.everyMinutes)||input.everyMinutes<5||input.everyMinutes>1440))throw Error('everyMinutes must be an integer from 5 to 1440');
 if(input.active!==undefined&&typeof input.active!=='boolean')throw Error('active must be a boolean');
 if(input.untilTaskDone!==undefined&&typeof input.untilTaskDone!=='boolean')throw Error('untilTaskDone must be a boolean');
 if(input.message!==undefined&&input.message!==null&&(typeof input.message!=='string'||input.message.length>2000))throw Error('message must be text of at most 2000 characters');
 if(input.endsAt!==undefined&&input.endsAt!==null&&(!Number.isSafeInteger(input.endsAt)||input.endsAt<=now))throw Error('endsAt must be a future timestamp in milliseconds');
}
export function createSchedule(hub:Hub,input:ScheduleInput,now=Date.now()):Schedule {
 if(!input||typeof input.agent!=='string'||!Number.isInteger(input.everyMinutes))throw Error('agent and everyMinutes are required');validate(input,now);
 const a=hub.store.listAgents().find(a=>a.id===input.agent||a.name===input.agent);if(!a)throw Error('no such agent');
 const task=input.task?hub.store.resolveTask(input.task):null;if(input.task&&!task)throw Error('no such task');
 const row:Schedule={id:crypto.randomUUID(),agentId:a.id,taskId:task?.id??null,kind:'check-in',everyMinutes:input.everyMinutes,message:input.message?.trim()||null,nextRun:now+input.everyMinutes*MINUTE,untilTaskDone:input.untilTaskDone??true,endsAt:input.endsAt??null,createdAt:now,active:true,lastFired:null,missedCount:0,stoppedReason:null};
 const reason=unavailable(hub,row,now);if(reason)throw Error(reason);
 const duplicate=hub.store.listSchedules().find(s=>s.agentId===a.id&&s.taskId===row.taskId);if(duplicate)throw Error('a schedule already exists for this agent and task; edit or delete it');
 hub.store.db.transaction(()=>{hub.store.db.query('INSERT INTO schedules(id,agent_id,task_id,every_minutes,message,next_run,until_task_done,ends_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(row.id,row.agentId,row.taskId,row.everyMinutes,row.message,row.nextRun,Number(row.untilTaskDone),row.endsAt,now);log(hub,row.id,now,'created');})();hub.notify();return row;
}
export function updateSchedule(hub:Hub,id:string,patch:SchedulePatch,now=Date.now()):Schedule {
 const s=hub.store.scheduleById(id);if(!s)throw Error('no such schedule');if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('schedule update required');if(Object.keys(patch).some(key=>!["active","everyMinutes","message","untilTaskDone","endsAt"].includes(key)))throw Error("unsupported schedule field");validate(patch,now);
 const next={...s,...patch,message:patch.message===undefined?s.message:patch.message?.trim()||null};
 if(next.active){const reason=unavailable(hub,next,now);if(reason)throw Error(reason);next.stoppedReason=null;}
 if(patch.everyMinutes!==undefined||(patch.active===true&&!s.active))next.nextRun=now+next.everyMinutes*MINUTE;
 hub.store.db.transaction(()=>{hub.store.db.query('UPDATE schedules SET every_minutes=?,message=?,next_run=?,until_task_done=?,ends_at=?,active=?,stopped_reason=? WHERE id=?').run(next.everyMinutes,next.message,next.nextRun,Number(next.untilTaskDone),next.endsAt,Number(next.active),next.stoppedReason,id);log(hub,id,now,patch.active===false?'paused':patch.active===true?'resumed':'updated');})();hub.notify();return next;
}
export function deleteSchedule(hub:Hub,id:string){if(!hub.store.scheduleById(id))throw Error('no such schedule');hub.store.db.transaction(()=>{hub.store.db.query('DELETE FROM schedule_events WHERE schedule_id=?').run(id);hub.store.db.query('DELETE FROM schedules WHERE id=?').run(id);})();hub.notify();return{ok:true};}
function latestReply(hub:Hub,agentId:string){const thread='dm:'+['human',agentId].sort().join(':');return hub.store.db.query('SELECT id,created_at AS createdAt FROM messages WHERE sender=? AND thread=? AND tainted=0 ORDER BY id DESC LIMIT 1').get(agentId,thread) as {id:number;createdAt:number}|null;}
export function schedulesView(hub:Hub){return hub.store.listSchedules().map(s=>{const a=hub.store.agentById(s.agentId),task=s.taskId?hub.store.getTask(s.taskId):null;return{...s,agent:a?.name.split('~revoked~')[0]??'removed',workspaceId:a?.workspaceId??null,task:task?.key??null,taskTitle:task?.title??null,lastReplyAt:latestReply(hub,s.agentId)?.createdAt??null,log:hub.store.scheduleEvents(s.id)};});}
/** One synchronous transaction advances all due rows from now. Restart/downtime never replays elapsed intervals. */
export function tickSchedules(hub:Hub,now=Date.now()){
 let changed=false;
 hub.store.db.transaction(()=>{
  for(const s of hub.store.listSchedules()){
   const stop=unavailable(hub,s,now);
   if(stop){if(s.stoppedReason!==stop||s.active){hub.store.db.query('UPDATE schedules SET active=0,stopped_reason=? WHERE id=?').run(stop,s.id);log(hub,s.id,now,'stopped ('+stop+')');changed=true;}continue;}
   if(!s.active||s.nextRun>now)continue;
   changed=true;hub.store.db.query('UPDATE schedules SET next_run=? WHERE id=?').run(now+s.everyMinutes*MINUTE,s.id);
   const a=activeAgent(hub,s.agentId,now)!,reply=latestReply(hub,a.id);
   const pending=hub.store.db.query('SELECT message_id AS id FROM checkin_pending WHERE agent_id=?').get(a.id) as {id:number}|null;
   if(now-a.lastSeen>=ONLINE||a.lastSeen===0){hub.store.db.query('UPDATE schedules SET missed_count=missed_count+1 WHERE id=?').run(s.id);log(hub,s.id,now,'missed (agent offline)');continue;}
   if(pending&&(!reply||reply.id<pending.id)){log(hub,s.id,now,'coalesced (unanswered check-in pending)');continue;}
   if(pending)hub.store.db.query('DELETE FROM checkin_pending WHERE agent_id=?').run(a.id);
   if(reply&&reply.createdAt>=now-s.everyMinutes*MINUTE/2){log(hub,s.id,now,'skipped (agent replied recently)');continue;}
   const task=s.taskId?hub.store.getTask(s.taskId):null;
   const context=task?`, task ${task.key}`:'';
   const text=`Scheduled check-in (every ${s.everyMinutes} min${context}): post a short status to the human with say(thread=dm:human): what is done, what is next, any blocker. Then continue.`+(task?`\nTask ${task.key}: ${task.title}\nStatus: ${task.status}`:'')+(s.message?`\nHuman note: ${s.message}`:'');
   const m=hub.store.addMessage({thread:'dm:'+['human',a.id].sort().join(':'),from:'human',text},now);
   hub.store.db.query('INSERT OR REPLACE INTO checkin_pending(agent_id,message_id) VALUES (?,?)').run(a.id,m.id);
   hub.store.db.query('UPDATE schedules SET last_fired=? WHERE id=?').run(now,s.id);
   log(hub,s.id,now,hub.activityOf(a.id,now).state==='working'?'agent busy, check-in queued':'check-in queued',m.id);
  }
 })();
 if(changed)hub.notify();return{changed};
}
