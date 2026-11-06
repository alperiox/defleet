import { KNOWLEDGE_NUDGE } from "../shared/knowledge";
import { createSchedule, updateSchedule, deleteSchedule, tickSchedules, schedulesView, type ScheduleInput, type SchedulePatch } from "./schedules";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import type { KnowledgeContext, KnowledgeInput } from "./knowledge";
import type { Agent, Artifact, Workspace, ArtifactKind, Evidence, Message, Request, RequestKind, Store, Task, TaskEvent, TaskStatus } from "./store";

export type WorkItem =
  | { type: "task"; task: Task; trust: Trust; by: Sender }
  | { type: "answer"; request: Request; trust: Trust; by: Sender }
  | { type: "message"; message: Message; trust: Trust; by: Sender };

export interface Ack { msg: number; task: number; answers: string[]; interrupted?: { type: "message" | "task"; id: string; seq: number }[] }
export interface WaitResult { items: WorkItem[]; ack: Ack }

export const HUMAN = "human";
export const ROOM_REPLY_WINDOW_MS = 20 * 60_000;

/** Where an item came from. Only "owner" items are instructions; the rest are data to be handled with care. */
export type Trust = "owner" | "external" | "tainted";
export type ActivityState = "idle" | "working";
export interface Activity { state: ActivityState; since: number; note?: string; turn?: string; stopRequested?: boolean; stoppedTurn?: string }
export interface Lease { holder: string; since: number; state: "active" | "stale" }
export type DeliveryState = "queued" | "received" | "read";
export interface Delivery { agent: string; state: DeliveryState }

/** A working state older than this is not believed: the helper that reported it has most likely died. */
const WORKING_TTL_MS = 45 * 60_000;
/** Names used for broadcasts or human/interface identities, so no agent may have them. */
export const RESERVED_NAMES = ["all", "everyone", "human", "you"];

/** A workspace's room. The default workspace keeps the original thread name, so rooms from before workspaces are still its room. */
export const roomOf = (workspaceId: string) => (workspaceId === "default" ? "room" : `room:${workspaceId}`);
export const isRoom = (thread: string) => thread === "room" || thread.startsWith("room:");
export const workspaceOfRoom = (thread: string) => (thread === "room" ? "default" : thread.slice(5));

/** Whether `text` mentions @name as a whole word (so @claude does not match @claude-laptop). */
export const mentions = (text: string, name: string) => new RegExp(`(^|[^a-z0-9-])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`, "i").test(text);
export interface Sender { name: string; owner: string }

export class Hub {
  private listeners = new Set<() => void>();
  /** Where uploaded files live. Set by createApp. */
  dataDir = "";
  diskNotice: (message:string)=>void = () => {};
  checkArtifactSpace: (adding:number)=>string|null = () => null;
  canAccessRepo(agent:Agent,project:string):boolean { return !agent.quarantined && this.store.getWorkspace(agent.workspaceId)?.id!==undefined && (this.store.db.query("SELECT visibility FROM workspaces WHERE id=?").get(agent.workspaceId) as any)?.visibility !== "private" && this.canAccessProject(agent,project); }
  /** The human who runs this hub. Agents owned by anyone else are external. Empty means everyone is internal. */
  hubOwner = "";
  humanAttachmentMaxBytes = 25 * 1024 * 1024;
  humanAttachmentMaxCount = 10;
  /** What each helper last said it was doing, and the highest message id handed to each agent (received, not yet read). */
  private activity = new Map<string, Activity>();
  private stopListeners = new Map<string, Set<(event: { type: "stop"; turn: string }) => void>>();
  private delivered = new Map<string, number>();
  /** A claim is a lease: it lapses when the holder has been silent this long and is not mid-turn. */
  leaseMs = 30 * 60_000;
  /** How long an offered task waits for an answer before it goes back to the pool. */
  offerMs = 15 * 60_000;

  constructor(public store: Store) {}
  private scheduleTimer?:ReturnType<typeof setInterval>;
  createSchedule(input:ScheduleInput,now=Date.now()){return createSchedule(this,input,now);}
  updateSchedule(id:string,patch:SchedulePatch,now=Date.now()){return updateSchedule(this,id,patch,now);}
  deleteSchedule(id:string){return deleteSchedule(this,id);}
  schedulesView(){return schedulesView(this);}
  tickSchedules(now=Date.now()){return tickSchedules(this,now);}
  startScheduleTicker(){if(this.scheduleTimer)return;const tick=()=>{try{this.tickSchedules();}catch(e){console.error("schedule tick failed",e);}};tick();this.scheduleTimer=setInterval(tick,30000);this.scheduleTimer.unref();}
  stopScheduleTicker(){if(this.scheduleTimer)clearInterval(this.scheduleTimer);this.scheduleTimer=undefined;}


  private knowledgeContext(agent: Agent): KnowledgeContext {
    return { workspaceId: agent.workspaceId, actor: agent.id, allowed: !this.isExternal(agent) && !agent.quarantined };
  }
  private humanKnowledgeContext(workspaceId: string): KnowledgeContext { return { workspaceId, actor: HUMAN, human: true, allowed: true }; }
  searchKnowledge(agent: Agent, options: { query?: string; kind?: string; project?: string; limit?: number }) { return this.store.knowledgeSearch(this.knowledgeContext(agent), options); }
  getKnowledge(agent: Agent, id: string) { return this.store.knowledgeGet(this.knowledgeContext(agent), id); }
  proposeKnowledge(agent: Agent, input: KnowledgeInput) { const r = this.store.knowledgeCreate(this.knowledgeContext(agent), input); this.notify(); return r; }
  verifyKnowledge(agent: Agent, id: string, ok: boolean, note: string) { const r = this.store.knowledgeVerify(this.knowledgeContext(agent), id, ok, note); this.notify(); return r; }
  knowledgeIndex(agent: Agent) { return this.store.knowledgeIndex(this.knowledgeContext(agent)); }
  humanKnowledge(workspaceId: string, action: string, id?: string, body: any = {}) {
    const ctx = this.humanKnowledgeContext(workspaceId);
    if (action === "list") return this.store.knowledgeList(ctx, body);
    if (action === "get") return this.store.knowledgeGet(ctx, id!);
    if (action === "create") { const result = this.store.knowledgeCreate(ctx, body); this.notify(); return this.store.knowledgeGet(ctx, result.id); }
    const result = this.store.knowledgeChange(ctx, id!, action, body); this.notify(); return result;
  }

  setActivity(agent: Agent, state: ActivityState, note?: string, turn?: string) {
    if (state === "idle" && turn && this.activity.get(agent.id)?.turn !== turn) return;
    this.store.touchAgent(agent.id);
    const stoppedTurn = state === "idle" && turn && this.activity.get(agent.id)?.stopRequested ? turn : undefined;
    this.activity.set(agent.id, { state, since: Date.now(), ...(note ? { note } : {}), ...(turn ? { turn } : {}), ...(stoppedTurn ? { stoppedTurn } : {}) });
    this.notify();
  }

  onAgentStop(agentId: string, fn: (event: { type: "stop"; turn: string }) => void): () => void {
    const listeners = this.stopListeners.get(agentId) ?? new Set();
    this.stopListeners.set(agentId, listeners); listeners.add(fn);
    return () => { listeners.delete(fn); if (!listeners.size) this.stopListeners.delete(agentId); };
  }

  pendingStop(agentId: string): { type: "stop"; turn: string } | null {
    const activity = this.activityOf(agentId);
    return activity.state === "working" && activity.stopRequested && activity.turn ? { type: "stop", turn: activity.turn } : null;
  }

  stopAgent(name: string, text = "", attachments: string[] = []) {
    const agent = this.resolveAgent(name);
    if (this.isExternal(agent)) throw new Error("outside agents cannot be stopped from this hub");
    // Validate/store any DM before signaling: a refused attachment must never stop a turn.
    const message = text.trim() || attachments.length ? this.humanDm(agent.id, text, attachments) : null;
    const activity = this.activityOf(agent.id), listeners = this.stopListeners.get(agent.id);
    if (activity.state !== "working") return { stopped: false, reason: "idle", message };
    if (!listeners?.size) return { stopped: false, reason: "offline", message };
    if (!activity.turn) return { stopped: false, reason: "unsupported", message };
    if (activity.stopRequested) return { stopped: true, duplicate: true, turn: activity.turn, message };
    activity.stopRequested = true;
    const event = { type: "stop" as const, turn: activity.turn! };
    this.store.addTouch({ agentId: agent.id, action: `human stopped ${agent.name}`, target: "current turn", source: "human" });
    for (const fn of [...listeners]) fn(event);
    this.notify();
    return { stopped: true, turn: activity.turn, message };
  }

  activityOf(agentId: string, nowMs = Date.now()): Activity {
    const a = this.activity.get(agentId);
    if (!a || (nowMs - a.since > WORKING_TTL_MS && nowMs - (this.store.agentById(agentId)?.lastSeen ?? 0) >= 45000)) return { state: "idle", since: a?.since ?? 0 };
    return a;
  }

  /** The agents a message is for: the other side of a direct message, or a Room mention/saved human reply target (@all is every team agent). */
  recipientsOf(m: Message): Agent[] {
    const agents = this.store.listAgents().filter((a) => a.id !== m.from);
    if (m.thread.startsWith("dm:")) {
      const ids = m.thread.slice(3).split(":");
      return agents.filter((a) => ids.includes(a.id));
    }
    if (!isRoom(m.thread)) return [];
    const ws = workspaceOfRoom(m.thread);
    const everyone = mentions(m.text, "all") || mentions(m.text, "everyone");
    return agents.filter((a) => a.workspaceId === ws && !this.isExternal(a) && (everyone || mentions(m.text, a.name) || (m.from === HUMAN && m.replyToAgent === a.id)));
  }

  /** Where a message stands for each agent it is for: queued, received (handed over, turn not yet confirmed), read (turn confirmed). */
  deliveryFor(m: Message): Delivery[] {
    return this.recipientsOf(m).map((a) => {
      const cursor = this.store.getCursors(a.id).msg;
      const state: DeliveryState = cursor >= m.id || this.store.wasInterrupted(a.id, "message", String(m.id), m.id) ? "read" : (this.delivered.get(a.id) ?? 0) >= m.id ? "received" : "queued";
      return { agent: a.name, state };
    });
  }

  private markDelivered(agent: Agent, result: WaitResult) {
    const top = Math.max(0, ...result.items.filter((i) => i.type === "message").map((i: any) => i.message.id));
    if (top > (this.delivered.get(agent.id) ?? 0)) { this.delivered.set(agent.id, top); this.notify(); }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of [...this.listeners]) fn();
  }

  private touch(agent: Agent, action: string, target: string) {
    this.store.touchAgent(agent.id);        // every action an agent takes shows it is alive, which is what keeps its leases
    this.store.addTouch({ agentId: agent.id, action, target, source: "hub" });
  }

  private resolveAgent(nameOrId: string): Agent {
    const found = this.store.listAgents().find((a) => a.id === nameOrId || a.name === nameOrId);
    if (!found) throw new Error(`unknown agent: ${nameOrId}`);
    return found;
  }

  /** Removes an agent: what it held goes back to the pool at once (not after a lease runs out), anything still waiting to start it is cancelled, and its token stops working. */
  removeAgent(name: string): { released: string[]; unassigned: string[] } | null {
    const agent = this.store.listAgents().find((a) => a.name === name);
    if (!agent) return null;
    const released: string[] = [], unassigned: string[] = [];
    for (const t of this.store.listTasks()) {
      if (t.status === "done" || t.status === "backlog") continue;
      if (t.claimedBy === agent.id) { this.store.releaseTask(t.id, null); this.event(t.id, HUMAN, "released", `${agent.name} was removed; the task is back in the pool`); released.push(t.key); }
      else if (t.assignee === agent.id) { this.store.releaseTask(t.id, null); this.event(t.id, HUMAN, "released", `${agent.name} was removed; the task is unassigned`); unassigned.push(t.key); }
    }
    for (const r of this.store.listDeviceRequests(500)) if (r.agentId === agent.id && ["pending", "delivered", "awaiting-confirmation"].includes(r.status)) this.store.setDeviceRequest(r.id, "failed", "the agent was removed");
    this.store.revokeAgent(agent.name);
    this.notify();
    return { released, unassigned };
  }

  workspaceNameOf(agent: Agent): string {
    return this.store.getWorkspace(agent.workspaceId)?.name ?? "Default";
  }

  isExternal(agent: Agent): boolean {
    return !!this.hubOwner && agent.owner !== this.hubOwner;
  }

  /** Internal agents see every project; external agents only the ones they were granted. */
  /** Team agents work inside their own workspace: a project belongs to one workspace (or to none yet, and is created in the creator's). Outside agents see only what they were granted. */
  canAccessProject(agent: Agent, project: string): boolean {
    if (this.isExternal(agent)) return this.store.projectsOf(agent.id).includes(project);
    const ws = this.store.projectWorkspace(project);
    return ws === null || ws === agent.workspaceId;
  }

  // ---- workspaces ----

  private cleanWorkspaceName(name: string): string {
    const n = (name ?? "").trim();
    if (!n || n.length > 60) throw new Error("a workspace name needs 1 to 60 characters");
    return n;
  }

  createWorkspace(name: string): Workspace {
    const n = this.cleanWorkspaceName(name);
    if (this.store.workspaceByName(n)) throw new Error(`a workspace named ${n} already exists`);
    const w = this.store.addWorkspace(n);
    this.notify();
    return w;
  }

  renameWorkspace(id: string, name: string): Workspace {
    const w = this.store.getWorkspace(id);
    if (!w) throw new Error("no workspace with that id");
    const n = this.cleanWorkspaceName(name);
    const clash = this.store.workspaceByName(n);
    if (clash && clash.id !== id) throw new Error(`a workspace named ${n} already exists`);
    this.store.renameWorkspace(id, n);
    this.notify();
    return this.store.getWorkspace(id)!;
  }

  /** A workspace by its id or its name. */
  resolveWorkspace(ref: string): Workspace {
    const w = this.store.getWorkspace(ref) ?? this.store.workspaceByName(ref);
    if (!w) throw new Error(`no workspace named ${ref}`);
    return w;
  }

  /** Moves an agent to another workspace. It must hold nothing, so no task is left claimed by someone who cannot see it. */
  moveAgent(agentName: string, workspaceRef: string): Agent {
    const agent = this.resolveAgent(agentName);
    const ws = this.resolveWorkspace(workspaceRef);
    const holding = this.store.listTasks().filter((t) => t.claimedBy === agent.id && t.status !== "done" && t.status !== "backlog");
    if (holding.length) throw new Error(`${agent.name} still holds ${holding.map((t) => t.key).join(", ")}: release or complete ${holding.length > 1 ? "them" : "it"} first`);
    this.store.setAgentWorkspace(agent.id, ws.id);
    this.notify();
    return this.store.agentById(agent.id)!;
  }

  grant(agentName: string, project: string) { this.store.grantProject(this.resolveAgent(agentName).id, project); }
  revokeGrant(agentName: string, project: string) { this.store.revokeProject(this.resolveAgent(agentName).id, project); }

  listTasksFor(agent: Agent, project?: string): Task[] {
    this.sweepOffers();
    return this.store.listTasks(project).filter((t) => this.canAccessTask(agent, t)).map((t) => this.taskForAgent(t, agent));
  }

  private canReadTaskRef(agent: Agent, id: string): boolean {
    const t = this.store.getTask(id); return !!t && this.canAccessTask(agent, t);
  }
  canAccessTask(agent: Agent, task: Task): boolean {
    return task.status !== "backlog" && this.canAccessProject(agent, task.project) && (!task.visibleToAgent || task.visibleToAgent === agent.id);
  }
  private taskForAgent(task: Task, agent?: Agent): Task {
    const parent = task.parentId ? this.store.getTask(task.parentId) : null;
    return agent && parent && !this.canAccessTask(agent, parent) ? { ...task, parentId: null } : task;
  }

  /** Looks a task up for an agent; a task in a project the agent cannot access does not exist for it. */
  private task(ref: string, agent?: Agent): Task {
    const t = this.store.resolveTask(ref);
    if (!t || (agent && !this.canAccessTask(agent, t))) throw new Error("no such task");
    return this.taskForAgent(t, agent);
  }

  private event(taskId: string, actor: string, kind: string, text: string) {
    this.store.addTaskEvent({ taskId, actor, kind, text });
  }

  private resolveThread(agent: Agent, thread: string): string {
    if (thread === "room") {
      if (this.isExternal(agent)) throw new Error("external agents cannot use the main room: DM one of the team's agents, or work through a shared project's tasks");
      return roomOf(agent.workspaceId);        // "the room" means the room of your own workspace
    }
    if (!thread.startsWith("dm:")) throw new Error(`unknown thread: ${thread}`);
    const other = thread.slice(3);
    const target = other === HUMAN ? null : this.resolveAgent(other);
    if (target && !this.isExternal(agent) && !this.isExternal(target) && target.workspaceId !== agent.workspaceId)
      throw new Error(`${target.name} works in another workspace and cannot be messaged from yours`);
    return "dm:" + [agent.id, target ? target.id : HUMAN].sort().join(":");
  }

  createTask(agent: Agent, t: { title: string; project: string; parentId?: string; assignee?: string; aiGenerated?: boolean; description?: string; acceptance?: string; needsPreview?: boolean }): Task {
    // Another agent must be able to pick this up with no questions, so a bare title is refused.
    if ((t.description ?? "").trim().length < 30)
      throw new Error("description required (at least a couple of sentences): what to build, where it lives, why it matters, links to anything relevant");
    if ((t.acceptance ?? "").trim().length < 5)
      throw new Error("acceptance required: how someone can tell this is done (checks to run, behavior to see)");
    if (!this.canAccessProject(agent, t.project)) throw new Error(`not allowed: you have no access to project ${t.project}`);
    if (!this.isExternal(agent)) this.store.ensureProject(t.project, agent.workspaceId);
    const parent = t.parentId ? this.task(t.parentId, agent) : null;
    if (parent?.status === "done") throw new Error(`parent task ${parent.key} is done; create a new top-level task instead`);
    const assignee = t.assignee ? this.resolveAgent(t.assignee).id : undefined;
    if (parent?.visibleToAgent && assignee && assignee !== parent.visibleToAgent) throw new Error("only the human can reassign private work");
    const task = this.store.addTask({
      title: t.title, project: t.project, parentId: parent?.id, createdBy: agent.id,
      aiGenerated: !!parent || !!t.aiGenerated, assignee, description: t.description!.trim(), acceptance: t.acceptance!.trim(), tainted: !!agent.quarantined, previewRequired: !!t.needsPreview,
    });
    if (parent?.visibleToAgent) this.store.setTaskAudience(task.id, parent.visibleToAgent);
    // An agent handing work to another agent is making an offer: the other agent may accept or decline it.
    const offered = !!assignee && assignee !== agent.id;
    if (offered) this.store.setOffer(task.id, agent.id);
    this.event(task.id, agent.id, "created", assignee ? `created and ${offered ? "offered to" : "assigned to"} ${this.resolveAgent(assignee).name}` : "created");
    this.touch(agent, "create_task", task.key);
    this.notify();
    return this.store.getTask(task.id)!;
  }

  /** Who holds a task and whether that still means anything: stale when the holder has been silent for the lease time and its helper is not reporting a running turn. */
  leaseOf(task: Task, nowMs = Date.now()): Lease | null {
    if (!task.claimedBy || task.status === "done" || task.status === "backlog") return null;
    const holder = this.store.agentById(task.claimedBy);
    if (!holder) return null;
    const silent = nowMs - holder.lastSeen > this.leaseMs && this.activityOf(holder.id, nowMs).state !== "working";
    return { holder: holder.name, since: task.claimedAt ?? 0, state: silent ? "stale" : "active" };
  }

  claim(agent: Agent, taskId: string, nowMs = Date.now()): Task {
    this.sweepOffers(nowMs);
    const found = this.task(taskId, agent);
    if (found.status === "done") throw new Error("task already done");
    const wasOffer = this.offerFor(agent, found);
    this.store.touchAgent(agent.id);
    const lease = this.leaseOf(found, nowMs);
    if (lease && found.claimedBy !== agent.id) {
      if (lease.state === "active") {
        // Show the human the contention, and tell the agent plainly not to do the work twice.
        this.event(found.id, agent.id, "claim-refused", `tried to claim, but ${lease.holder} holds it`);
        this.notify();
        throw new Error(`already claimed: held by ${lease.holder} since ${new Date(lease.since).toISOString().slice(11, 16)} UTC (active). Do not work on this task in parallel. If you can help, ask ${lease.holder} with ask_owner; if you think they are stuck or you have a better version, tell the human with ask_human. Otherwise pick another task.`);
      }
      // The holder has gone quiet: the task moves to whoever asks, and the history says why.
      if (found.assignee && found.assignee !== agent.id) throw new Error("assigned to another agent");
      this.store.takeOverTask(found.id, agent.id);
      this.event(found.id, agent.id, "lease-expired", `${lease.holder}'s lease expired (silent for over ${Math.round(this.leaseMs / 60_000)} min); taken over by ${agent.name}`);
      this.touch(agent, "claim_task", found.key);
      this.notify();
      return this.store.getTask(found.id)!;
    }
    const task = this.store.claimTask(found.id, agent.id);
    this.event(task.id, agent.id, wasOffer ? "accepted" : "claimed", wasOffer ? "accepted the offer" : "claimed");
    this.touch(agent, "claim_task", task.key);
    this.notify();
    return task;
  }

  private owned(agent: Agent, taskId: string): Task {
    const task = this.task(taskId, agent);
    if (task.claimedBy !== agent.id) {
      const holder = task.claimedBy ? this.store.agentById(task.claimedBy)?.name : null;
      throw new Error(holder
        ? `not your task: ${task.key} is held by ${holder} now, and you are ${agent.name}. If you are meant to continue ${holder}'s work, ask the human to reassign it to you (on the task page: Reassign to…); otherwise leave it alone.`
        : "not your task");
    }
    return task;
  }

  postStatus(agent: Agent, taskId: string, status: TaskStatus, note?: string): void {
    const task = this.owned(agent, taskId);
    if (task.status === "done") throw new Error("task already done");
    if (status === "backlog") throw new Error("only the human can put tasks in backlog");
    if (status === "done") throw new Error("use complete_task to finish a task (it needs evidence)");
    if (status === "open" || status === "claimed") throw new Error("use release_task to give a task back");
    this.store.setStatus(task.id, status, note);
    this.event(task.id, agent.id, "status", status + (note ? `: ${note}` : ""));
    this.touch(agent, "post_status", `${task.key}:${status}`);
    this.notify();
  }

  attachEvidence(agent: Agent, taskId: string, e: { kind: string; ref: string; note?: string }): void {
    const task = this.owned(agent, taskId);
    this.store.addEvidence(task.id, e);
    this.event(task.id, agent.id, "evidence", `${e.kind}: ${e.ref}${e.note ? ` — ${e.note}` : ""}`);
    this.touch(agent, "attach_evidence", task.key);
    this.notify();
  }

  release(agent: Agent, taskId: string, to?: string, brief?: string): Task {
    const task = this.owned(agent, taskId);
    if (task.status === "done") throw new Error("task already done");
    const note = (brief ?? "").trim();
    if (note.length < 20)
      throw new Error("brief required (a couple of sentences): what is done so far, what is left, and where the files, branch or notes are. The next agent starts from this.");
    const target = to ? this.resolveAgent(to) : null;
    if (task.visibleToAgent && target && target.id !== task.visibleToAgent) throw new Error("only the human can reassign a private task");
    if (target && this.isExternal(target))
      throw new Error("handing a task to an external agent needs the human's approval: ask the human with ask_human, or let that agent request it");
    const released = this.store.releaseTask(task.id, target ? target.id : task.visibleToAgent ?? undefined, note, target ? agent.id : undefined);
    this.event(task.id, agent.id, "handoff", note);
    this.event(task.id, agent.id, "released", target ? `offered to ${target.name}` : "released to the pool");
    // The brief also reaches the named agent as a message, which is what wakes it.
    if (target) this.store.addMessage({ thread: this.resolveThread(agent, "dm:" + target.name), from: agent.id, text: `Offer: ${task.key} "${task.title}". Handoff brief: ${note}\n\nAccept it with accept_task, or decline_task with a reason.` });
    this.touch(agent, "release_task", task.key);
    this.notify();
    return released;
  }

  // ---- offers: delegating is asking, and the other agent may say no ----

  /** The offer an agent has pending on this task, if any. */
  private offerFor(agent: Agent, task: Task): boolean {
    return task.offerBy !== null && task.assignee === agent.id && !task.claimedBy;
  }

  acceptTask(agent: Agent, taskId: string): Task {
    const task = this.task(taskId, agent);
    if (!this.offerFor(agent, task)) throw new Error(`no offer: ${task.key} is not waiting for your answer`);
    return this.claim(agent, task.id);
  }

  declineTask(agent: Agent, taskId: string, reason: string): Task {
    const task = this.task(taskId, agent);
    if (!this.offerFor(agent, task)) throw new Error(`no offer: ${task.key} is not waiting for your answer`);
    const why = (reason ?? "").trim();
    if (why.length < 5) throw new Error("reason required: say why (busy, wrong tool, missing access) and, if you know, who would be better");
    const offeredBy = task.offerBy!;
    const back = this.store.clearOffer(task.id);
    this.event(task.id, agent.id, "declined", why);
    const delegator = this.store.agentById(offeredBy);
    if (delegator && delegator.id !== agent.id)
      this.store.addMessage({ thread: this.resolveThread(agent, "dm:" + delegator.name), from: agent.id, text: `${task.key} "${task.title}": I declined it. ${why}\n\nIt is back in the pool, so you can offer it to someone else. The human can also assign it directly.` });
    this.touch(agent, "decline_task", task.key);
    this.notify();
    return back;
  }

  /** Offers nobody answered in time go back to the pool, and the history says so. */
  sweepOffers(nowMs = Date.now()): void {
    let changed = false;
    for (const t of this.store.offeredTasks()) {
      if (t.offerAt === null || nowMs - t.offerAt <= this.offerMs) continue;
      const who = t.assignee ? this.store.agentById(t.assignee)?.name ?? "the agent" : "the agent";
      this.store.clearOffer(t.id);
      this.event(t.id, HUMAN, "offer-expired", `${who} did not answer within ${Math.round(this.offerMs / 60_000)} min; back in the pool`);
      changed = true;
    }
    if (changed) this.notify();
  }

  // ---- profiles ----

  setRole(agent: Agent, role: string): void {
    const text = (role ?? "").trim();
    if (text.length > 200) throw new Error("role is at most 200 characters: one or two lines on what you are for and not for");
    this.store.setRole(agent.id, text);
    this.touch(agent, "set_profile", "role");
    this.notify();
  }

  /** Standing instructions are the human's alone: there is deliberately no tool for an agent to write them. */
  setInstructions(agent: Agent, text: string): void {
    const t = (text ?? "").trim();
    if (t.length > 4000) throw new Error("instructions are at most 4000 characters");
    this.store.setInstructions(agent.id, t);
    this.notify();
  }

  /** The team as a delegating agent needs it: who is for what, who is around, and how busy. Outside agents see nothing. */
  listTeam(agent: Agent, nowMs = Date.now()): { name: string; role: string; online: boolean; state: string; device: string; tool?: string; model?: string; folder?: string; workspace: string; load: { working: number; offers: number }; you: boolean }[] {
    if (this.isExternal(agent)) return [];
    this.sweepOffers(nowMs);
    const tasks = this.store.listTasks().filter((t) => this.canAccessTask(agent, t));
    return this.store.listAgents().filter((a) => !this.isExternal(a) && a.workspaceId === agent.workspaceId).map((a) => {
      const launch = this.store.launchOf(a.id);
      return {
        name: a.name, role: a.role, online: !!a.lastSeen && nowMs - a.lastSeen < 45_000, state: this.activityOf(a.id, nowMs).state, device: a.device,
        ...(launch ? { tool: launch.harness, model: launch.model, folder: launch.dir } : {}),
        workspace: this.workspaceNameOf(a),
        load: {
          working: tasks.filter((t) => t.claimedBy === a.id && t.status !== "done").length,
          offers: tasks.filter((t) => t.assignee === a.id && t.offerBy !== null && !t.claimedBy).length,
        },
        you: a.id === agent.id,
      };
    });
  }

  /** Human overrides are explicit and bypass agent completion evidence gates. */
  humanStatus(taskRef: string, status: TaskStatus, note?: string): Task {
    const task = this.task(taskRef);
    if (!["backlog", "open", "claimed", "in_progress", "blocked", "done"].includes(status)) throw new Error("invalid task status");
    this.store.db.transaction(() => {
      if (status === "backlog") {
        this.store.db.query("UPDATE tasks SET claimed_by = NULL, claimed_at = NULL, assignee = NULL, visible_to_agent = NULL, offer_by = NULL, offer_at = NULL WHERE id = ?").run(task.id);
      } else {
        this.store.db.query("UPDATE tasks SET offer_by = NULL, offer_at = NULL WHERE id = ?").run(task.id);
        if (status === "open") this.store.db.query("UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = ?").run(task.id);
        else if (["claimed", "in_progress", "blocked"].includes(status) && !task.claimedBy) {
          this.store.db.query("UPDATE tasks SET claimed_by = ?, claimed_at = ? WHERE id = ?").run(task.assignee ?? HUMAN, Date.now(), task.id);
        }
      }
      this.store.setStatus(task.id, status, note);
      if (status === "open" && task.status !== "open") this.store.activateTask(task.id);
      this.event(task.id, HUMAN, "status", `${task.status} → ${status}${note !== undefined ? ": " + note : ""}`);
    })();
    this.notify();
    return this.store.getTask(task.id)!;
  }

  /** Assignment exposes a backlog task only to the chosen agent; there is no free-text mention parser. */
  humanRelease(taskId: string, to?: string): Task {
    const task = this.task(taskId);
    const target = to ? this.resolveAgent(to) : null;
    if (target && !this.canAccessProject(target, task.project)) throw new Error("agent cannot access this task's workspace/project");
    if (task.status === "backlog" && !target) throw new Error("choose an agent or explicitly change backlog status to open");
    this.store.db.transaction(() => {
      this.store.releaseTask(task.id, target ? target.id : null);
      this.store.setTaskAudience(task.id, (task.status === "backlog" || task.visibleToAgent) && target ? target.id : null);
      this.store.activateTask(task.id);
      if (task.status === "backlog") this.event(task.id, HUMAN, "status", `backlog → open; privately assigned to ${target!.name} by the human`);
      this.event(task.id, HUMAN, "released", target ? `reassigned to ${target.name} by the human` : "released by the human");
    })();
    this.notify();
    return this.store.getTask(task.id)!;
  }

  /** Audit survives deletion; queued file IDs allow cleanup to resume after a crash. */
  cleanupTaskFiles(): void {
    for (const d of this.store.deletedTasks()) {
      if (!d.pendingFiles.length) continue;
      const pending: string[] = [];
      for (const id of d.pendingFiles) {
        try { rmSync(`${this.dataDir}/artifacts/${id}`, { force: true }); } catch { pending.push(id); }
      }
      this.store.setDeletionPending(d.taskId, pending);
    }
  }

  humanDeleteTask(taskRef: string, confirm: string): { ok: true; key: string; cleanupPending: boolean } {
    const task = this.task(taskRef);
    if (confirm !== task.key) throw new Error("confirm the exact task key to delete it");
    if (this.store.childrenOf(task.id).length) throw new Error("delete subtasks first; a task with subtasks cannot be deleted");
    this.store.deleteTaskRecord(task);
    this.cleanupTaskFiles();
    this.notify();
    return { ok: true, key: task.key, cleanupPending: !!this.store.deletedTasks().find((d) => d.taskId === task.id)?.pendingFiles.length };
  }

  canUseKnowledge(agent:Agent):boolean { return this.store.knowledgeCanUse(this.knowledgeContext(agent)); }

  complete(agent: Agent, taskId: string): Task & {knowledgeNudge?:string} {
    const task = this.owned(agent, taskId);
    if (this.store.evidenceFor(task.id).length === 0) throw new Error("evidence required");
    const open = this.store.childrenOf(task.id).filter((c) => c.status !== "done");
    if (open.some((t) => !this.canAccessTask(agent, t))) throw new Error("subtasks still open: ask the human to review hidden work");
    if (open.length > 0) throw new Error(`subtasks still open: ${open.map((c) => c.key).join(", ")}`);
    if (task.outcomeRequired && !this.store.artifactsFor(task.id).some((a) => a.kind === "report"))
      throw new Error("outcome report required: the human asked for one on this task. Call attach_report (and add screenshots or a video if the result is visual) before complete_task. See /skills/outcome-report.md on the hub.");
    if (task.previewRequired && !this.store.artifactsFor(task.id).some((a) => a.kind === "screenshot" || a.kind === "video"))
      throw new Error("preview required: the human wants to see this result. Attach at least one screenshot or a short video to the task (bun helper.ts upload <TASK> <file> --kind screenshot|video), then call complete_task again. Do not host a server for it. See /skills/screenshots.md on the hub.");
    this.store.setStatus(task.id, "done");
    this.event(task.id, agent.id, "completed", "completed");
    this.touch(agent, "complete_task", task.key);
    this.notify();
    return { ...this.store.getTask(task.id)!, ...(this.canUseKnowledge(agent)?{knowledgeNudge:KNOWLEDGE_NUDGE}:{}) };
  }

  knowledgeSuggestion(taskRef:string):{agentId?:string;agent?:string;reason?:string}{
    const task=this.task(taskRef);
    if(task.status!=="done")return{reason:"Finish this task before suggesting notes."};
    if(task.visibleToAgent)return{reason:"Notes from privately assigned tasks cannot be proposed."};
    if(task.tainted)return{reason:"Outside or quarantined task content cannot seed team knowledge."};
    const history=this.store.taskEvents(task.id).filter(e=>["claimed","accepted","completed","lease-expired"].includes(e.kind)&&e.actor!==HUMAN);
    const holder=task.claimedBy&&task.claimedBy!==HUMAN?task.claimedBy:history.at(-1)?.actor;
    if(!holder)return{reason:"No agent held this task."};
    const agent=this.store.listAgents().find(a=>a.id===holder&&(a.expiresAt===null||a.expiresAt>Date.now()));
    if(!agent||!this.canUseKnowledge(agent)||!this.canAccessTask(agent,task))return{reason:"The previous holder is unavailable or no longer has access to this task and team knowledge."};
    return{agentId:agent.id,agent:agent.name};
  }

  suggestKnowledge(taskRef:string){
    const task=this.task(taskRef),target=this.knowledgeSuggestion(task.id);
    if(target.reason)throw Error(target.reason);
    const message=this.humanDm(target.agentId!,`Suggest reusable setup, environment or gotcha notes from your finished work on ${task.key}: ${task.title} (project ${task.project}). Call propose_knowledge with a verification line and public sources; suggestions need human approval. Do not invent a note if nothing is reusable, and do not include secrets or private task/message material.`);
    this.event(task.id,HUMAN,"knowledge-suggestion",`Asked ${target.agent} to suggest reusable notes`);
    this.notify();return{ok:true,agent:target.agent,messageId:message.id};
  }

  /** Posts a message, optionally with files the agent already uploaded. Naming a task it holds also files them under that task. */
  say(agent: Agent, thread: string, text: string, attachments: string[] = [], taskRef?: string): Message {
    const key = this.resolveThread(agent, thread);
    if (attachments.length > 10) throw new Error("at most 10 attachments on a message");
    if (!text.trim() && !attachments.length) throw new Error("empty message: write something or attach a file");
    const task = attachments.length && taskRef ? this.owned(agent, taskRef) : null;
    const files = attachments.map((id) => {
      const a = this.store.getArtifact(id);
      if (!a) throw new Error(`no such upload: ${id}`);
      if (a.uploadedBy !== agent.id) throw new Error(`upload ${id} is not yours`);
      if (a.messageId != null) throw new Error(`upload ${id} is already attached to a message`);
      return a;
    });
    if (new Set(attachments).size !== attachments.length) throw new Error("the same upload is listed twice");
    const m = this.store.addMessage({ thread: key, from: agent.id, text, tainted: !!agent.quarantined });
    for (const a of files) {
      this.store.attachArtifact(a.id, m.id, task?.id);
      if (task) this.event(task.id, agent.id, "artifact", `${a.kind}: ${a.name}`);
    }
    this.touch(agent, "say", key);
    this.notify();
    return m;
  }

  /** Records a file the agent uploaded without a task. It stays unattached until a message uses it. */
  recordUpload(agent: Agent, a: { id: string; kind: ArtifactKind; name: string; mime: string; size: number }): Artifact {
    const art = this.store.addArtifact({ ...a, taskId: null, uploadedBy: agent.id });
    this.touch(agent, "upload", a.name);
    return art;
  }

  readThread(agent: Agent, thread: string, afterId: number): Message[] {
    return this.store.messagesSince(this.resolveThread(agent, thread), afterId);
  }

  askHuman(agent: Agent, r: { kind: RequestKind; text: string; link?: string; taskId?: string }): Request {
    const req = this.store.addRequest({ fromAgent: agent.id, owner: agent.owner, ...r, tainted: !!agent.quarantined });
    this.touch(agent, "ask_human", req.id);
    this.notify();
    return req;
  }

  // At-least-once: answers stay in the inbox until the agent acknowledges their ids.
  inbox(agent: Agent, ack: string[] = []): { answers: Request[] } {
    this.ackAnswers(agent, ack);
    return { answers: this.store.undeliveredAnswers(agent.id).filter((r) => !r.taskId || this.canReadTaskRef(agent, r.taskId)) };
  }

  myRequests(agent: Agent): Request[] {
    return this.store.requestsFor(agent.id).filter((r) => !r.taskId || this.canReadTaskRef(agent, r.taskId));
  }

  private ackAnswers(agent: Agent, ids: string[]) {
    if (ids.length === 0) return;
    const mine = new Set(this.store.requestsFor(agent.id).map((r) => r.id));
    for (const id of ids) if (mine.has(id)) this.store.markDelivered(id);
  }

  recordTouch(agent: Agent, action: string, target: string): void {
    this.store.addTouch({ agentId: agent.id, action, target, source: "declared" });
  }

  // Human-side writes, called by the REST layer. They go through the hub so listeners fire.
  humanAnswer(requestId: string, answer: string) {
    const req = this.store.getRequest(requestId);
    this.store.answerRequest(requestId, answer);
    // Both sides of a dispute hear the decision: the asker gets the answer, the other agent a DM.
    if (req?.withAgent) {
      const thread = "dm:" + [req.withAgent, HUMAN].sort().join(":");
      const q = req.text.split("\n").find((l) => l.startsWith("**Question:**"))?.replace("**Question:** ", "") ?? "";
      this.store.addMessage({ thread, from: HUMAN, text: `Decision on the dispute "${q}":\n\n${answer}` });
    }
    this.notify();
  }
  /** The latest Room speaker owns the reply window; human follow-ups never extend it. */
  roomReplyWindow(workspaceId = "default") {
    const message = this.store.latestAgentMessage(roomOf(workspaceId));
    if (!message) return null;
    const agent = this.store.listAgents().find((a) => a.id === message.from);
    if (!agent || agent.workspaceId !== workspaceId || this.isExternal(agent)) return null;
    return { workspaceId, agent: agent.name, messageId: message.id, expiresAt: message.createdAt + ROOM_REPLY_WINDOW_MS };
  }

  humanSay(text: string, workspaceId = "default", attachments: string[] = []): Message {
    if (!this.store.getWorkspace(workspaceId)) throw new Error("no workspace with that id");
    const window = this.roomReplyWindow(workspaceId);
    // Any explicit @mention takes precedence, even if its name is unknown.
    const explicit = /(^|[^a-z0-9-])@[a-z0-9][a-z0-9-]*/i.test(text);
    const target = !explicit && window && Date.now() < window.expiresAt
      ? this.store.listAgents().find((a) => a.name === window.agent) : undefined;
    const m = this.humanMessage({ thread: roomOf(workspaceId), from: HUMAN, text, replyToAgent: target?.id }, attachments);
    this.notify();
    return m;
  }
  addComment(agent: Agent, taskId: string, text: string): void {
    const task = this.task(taskId, agent);
    this.event(task.id, agent.id, "comment", text);
    this.touch(agent, "comment", task.key);
    this.notify();
  }

  /** Sends a question about a task to whoever owns it: the claimer, else the assignee, else the creator. */
  askOwner(agent: Agent, taskId: string, question: string): Message {
    const task = this.task(taskId, agent);
    const ownerId = task.claimedBy ?? task.assignee ?? task.createdBy;
    if (ownerId === agent.id) throw new Error("you own this task, there is nobody else to ask");
    const thread = "dm:" + [agent.id, ownerId].sort().join(":");
    const m = this.store.addMessage({ thread, from: agent.id, text: `Question about ${task.key} "${task.title}":\n\n${question}`, tainted: !!agent.quarantined });
    this.event(task.id, agent.id, "question", question);
    this.touch(agent, "ask_owner", task.key);
    this.notify();
    return m;
  }

  /** Files a disagreement the agents cannot settle for the human. It lands in "Needs you", not a private message. */
  escalate(agent: Agent, d: { task?: string; withAgent?: string; question: string; myPosition: string; theirPosition?: string }): Request {
    const task = d.task ? this.task(d.task, agent) : null;
    const other = d.withAgent ? this.resolveAgent(d.withAgent) : null;
    const text = [
      `**Disagreement**${task ? ` on ${task.key} "${task.title}"` : ""}${other ? ` between ${agent.name} and ${other.name}` : ""}`,
      `**Question:** ${d.question}`,
      `**${agent.name}:** ${d.myPosition}`,
      ...(other && d.theirPosition ? [`**${other.name}:** ${d.theirPosition}`] : []),
    ].join("\n\n");
    const req = this.store.addRequest({ fromAgent: agent.id, owner: agent.owner, kind: "dispute", text, taskId: task?.id, withAgent: other?.id, tainted: !!agent.quarantined });
    if (task) {
      this.event(task.id, agent.id, "escalated", d.question);
      if (task.claimedBy === agent.id && task.status !== "done") this.store.setStatus(task.id, "blocked", `waiting on the human: ${d.question}`);
    }
    this.touch(agent, "escalate", req.id);
    this.notify();
    return req;
  }

  taskDetail(taskId: string, agent?: Agent): { task: Task; events: TaskEvent[]; evidence: Evidence[]; children: Task[]; artifacts: Artifact[] } {
    const task = this.task(taskId, agent);
    return {
      task, events: this.store.taskEvents(task.id), evidence: this.store.evidenceFor(task.id),
      children: this.store.childrenOf(task.id).filter((t) => !agent || this.canAccessTask(agent, t)).map((t) => this.taskForAgent(t, agent)), artifacts: this.store.artifactsFor(task.id),
    };
  }

  /** The task, if this agent holds it. Used before accepting an upload. */
  taskHeldBy(agent: Agent, taskRef: string): Task {
    return this.owned(agent, taskRef);
  }

  /** Records an uploaded file (already on disk under its id) against a task the agent holds. */
  recordArtifact(agent: Agent, taskRef: string, a: { id: string; kind: ArtifactKind; name: string; mime: string; size: number }): Artifact {
    const task = this.owned(agent, taskRef);
    const art = this.store.addArtifact({ ...a, taskId: task.id, uploadedBy: agent.id });
    this.event(task.id, agent.id, "artifact", `${a.kind}: ${a.name}`);
    this.touch(agent, "attach_artifact", task.key);
    this.notify();
    return art;
  }

  /** Stores a markdown report, verbatim, as the task's outcome. The title only names the file. */
  attachReport(agent: Agent, taskRef: string, title: string, markdown: string): Artifact {
    const task = this.owned(agent, taskRef);
    const error=this.checkArtifactSpace(Buffer.byteLength(markdown));if(error){this.diskNotice(error);throw Error(error);}
    const id = crypto.randomUUID();
    mkdirSync(`${this.dataDir}/artifacts`, { recursive: true });
    writeFileSync(`${this.dataDir}/artifacts/${id}`, markdown);
    const name = `${title.replace(/[^\w.\- ]+/g, "_").slice(0, 60).trim() || "report"}.md`;
    return this.recordArtifact(agent, task.id, { id, kind: "report", name, mime: "text/markdown; charset=utf-8", size: Buffer.byteLength(markdown) });
  }

  /** The human wants a written outcome before this task counts as done. */
  /** The human marks a task as needing a visual preview (screenshot or video) before it can be completed, or clears that. */
  setPreviewRequired(taskRef: string, required: boolean): Task {
    const task = this.task(taskRef);
    this.store.setPreviewRequired(task.id, required);
    this.event(task.id, HUMAN, required ? "preview-requested" : "preview-cleared", required ? "visual preview required" : "visual preview no longer required");
    const ownerId = task.claimedBy ?? task.assignee ?? null;
    if (required && ownerId && ownerId !== HUMAN) {
      const thread = "dm:" + [ownerId, HUMAN].sort().join(":");
      this.store.addMessage({ thread, from: HUMAN, text: `${task.key} "${task.title}" now needs a **visual preview**: attach a screenshot or short video to the task before completing it (\`bun helper.ts upload ${task.key} <file> --kind screenshot\`). Do not host a server for it.` });
    }
    this.notify();
    return this.store.getTask(task.id)!;
  }

  requestOutcome(taskRef: string): Task {
    const task = this.task(taskRef);
    this.store.setOutcomeRequired(task.id, true);
    this.event(task.id, HUMAN, "outcome-requested", "outcome report requested");
    const ownerId = task.claimedBy ?? task.assignee ?? null;
    if (ownerId && ownerId !== HUMAN) {
      const thread = "dm:" + [ownerId, HUMAN].sort().join(":");
      this.store.addMessage({ thread, from: HUMAN, text: `Please deliver an **outcome report** for ${task.key} "${task.title}" when it is done: call \`attach_report\` (a short markdown report) and add screenshots or a video if the result is visual. The task cannot be completed without the report. Read \`/skills/outcome-report.md\` on the hub for what a good one contains.` });
    }
    this.notify();
    return this.store.getTask(task.id)!;
  }

  /** A device that cannot sandbox outside requests refuses them: the sender is told, and the owner gets one card. */
  refuseUntrusted(agent: Agent, items: WorkItem[]): void {
    const untrusted = items.filter((i) => i.trust !== "owner");
    if (untrusted.length === 0) return;
    const lines: string[] = [];
    for (const it of untrusted) {
      if (it.type === "message") {
        lines.push(`- from ${it.by.name} (owner ${it.by.owner}): ${it.message.text}`);
        const senderId = it.message.from;
        if (senderId !== HUMAN && senderId !== agent.id) {
          this.store.addMessage({
            thread: "dm:" + [agent.id, senderId].sort().join(":"), from: agent.id, tainted: true,
            text: `Sorry, I can't handle requests from outside the team on this device, so I did not act on your message. I have told my owner; they can decide.`,
          });
        }
      } else if (it.type === "task") {
        lines.push(`- task ${it.task.key} from ${it.by.name} (owner ${it.by.owner}): ${it.task.title}`);
      }
    }
    this.store.addRequest({
      fromAgent: agent.id, owner: agent.owner, kind: "approval", tainted: true,
      text: `**${agent.name}** received ${untrusted.length} request(s) from outside the team and did not act on them, because this device cannot safely sandbox them:\n\n${lines.join("\n")}\n\nReply with what, if anything, ${agent.name} should do.`,
    });
    this.touch(agent, "refuse_untrusted", String(untrusted.length));
    this.notify();
  }

  private ownerOf(task: Task): string {
    return task.claimedBy ?? task.assignee ?? task.createdBy;
  }

  private dmTo(agent: Agent, otherId: string, text: string): Message {
    const thread = "dm:" + [agent.id, otherId].sort().join(":");
    return this.store.addMessage({ thread, from: agent.id, text, tainted: !!agent.quarantined });
  }

  /** What a finished (or unfinished) task produced: status, latest note, the report text and the files. */
  getOutcome(agent: Agent, taskRef: string) {
    const task = this.task(taskRef, agent);
    const artifacts = this.store.artifactsFor(task.id);
    const rep = artifacts.filter((a) => a.kind === "report").pop();
    let report: string | null = null;
    if (rep) { try { report = readFileSync(`${this.dataDir}/artifacts/${rep.id}`, "utf8"); } catch {} }
    return {
      key: task.key, title: task.title, status: task.status, note: task.note, report,
      artifacts: artifacts.map((a) => ({ id: a.id, kind: a.kind, name: a.name, size: a.size })),
    };
  }

  /** Any agent that can see a task may ask for its outcome: delivered if there is a report, otherwise the owner is asked. */
  askForOutcome(agent: Agent, taskRef: string) {
    const task = this.task(taskRef, agent);
    const ownerId = this.ownerOf(task);
    if (ownerId === agent.id) throw new Error("you own this task; write the outcome with attach_report");
    const out = this.getOutcome(agent, task.id);
    if (task.status === "done" && out.report) {
      this.event(task.id, agent.id, "outcome-shared", `outcome shared with ${agent.name}`);
      this.touch(agent, "get_outcome", task.key);
      this.notify();
      return { state: "delivered" as const, ...out };
    }
    if (task.status === "done") {
      this.dmTo(agent, ownerId, `${agent.name} asks for the outcome of ${task.key} "${task.title}", which is done but has no report. Please write one with \`attach_report\` (see /skills/outcome-report.md).`);
      this.event(task.id, agent.id, "outcome-asked", `${agent.name} asked for an outcome report`);
      this.touch(agent, "request_outcome", task.key);
      this.notify();
      return { state: "requested" as const, ...out };
    }
    this.dmTo(agent, ownerId, `${agent.name} asks how ${task.key} "${task.title}" is going (status: ${task.status}). A short update would help them.`);
    this.event(task.id, agent.id, "status-asked", `${agent.name} asked for a status update`);
    this.touch(agent, "request_outcome", task.key);
    this.notify();
    return { state: "status" as const, ...out };
  }

  /** Asks to finish someone else's open task. Between our own agents the owner decides; an external agent needs the human. */
  requestTakeover(agent: Agent, taskRef: string, reason: string) {
    const task = this.task(taskRef, agent);
    if (task.status === "done") throw new Error("that task is already done");
    if (task.claimedBy === agent.id) throw new Error("you already hold this task");
    const ownerId = this.ownerOf(task);
    this.event(task.id, agent.id, "takeover-requested", reason);
    this.touch(agent, "request_takeover", task.key);
    if (ownerId !== agent.id) this.dmTo(agent, ownerId, `${agent.name} asks to take over ${task.key} "${task.title}": ${reason}`);
    if (this.isExternal(agent)) {
      this.store.addRequest({
        fromAgent: agent.id, owner: agent.owner, kind: "handoff", taskId: task.id, tainted: !!agent.quarantined,
        text: `**${agent.name}** (owned by ${agent.owner}) asks to take over **${task.key} "${task.title}"**, currently with ${this.ownerName(ownerId)}.\n\n**Their reason:** ${reason}`,
      });
    }
    this.notify();
    return { state: "requested" as const, needsHuman: this.isExternal(agent) };
  }

  private ownerName(id: string): string {
    return id === HUMAN ? "you" : this.store.agentById(id)?.name ?? id;
  }

  /** The human approves or declines handing a task to an external agent. */
  decideHandoff(requestId: string, approve: boolean) {
    const req = this.store.getRequest(requestId);
    if (!req || req.kind !== "handoff" || req.answer !== null) throw new Error("no open handoff request");
    const task = req.taskId ? this.store.getTask(req.taskId) : null;
    if (!task) throw new Error("no such task");
    if (task.status === "backlog") throw new Error("assign this backlog task explicitly from its task page");
    let answer: string;
    if (approve && task.status !== "done") {
      const previous = task.claimedBy ?? task.assignee;
      this.store.releaseTask(task.id, req.fromAgent);
      this.event(task.id, HUMAN, "handed-over", `handed over to ${this.ownerName(req.fromAgent)} by the human`);
      answer = `Approved: ${task.key} is yours. Claim it with claim_task.`;
      if (previous && previous !== req.fromAgent && previous !== HUMAN)
        this.store.addMessage({ thread: "dm:" + [previous, HUMAN].sort().join(":"), from: HUMAN, text: `I handed ${task.key} "${task.title}" to ${this.ownerName(req.fromAgent)}. It is no longer yours.` });
    } else if (approve) {
      answer = `${task.key} is already done; see its outcome with request_outcome.`;
    } else {
      answer = `Declined: ${task.key} stays with its owner.`;
      this.event(task.id, HUMAN, "handoff-declined", `handoff to ${this.ownerName(req.fromAgent)} declined`);
    }
    this.store.answerRequest(requestId, answer);
    this.notify();
  }

  private humanMessage(message: { thread: string; from: string; text: string; replyToAgent?: string }, ids: string[]): Message {
    return this.store.db.transaction(() => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error("attachments must be an array of upload ids");
      if (ids.length > this.humanAttachmentMaxCount) throw new Error(`at most ${this.humanAttachmentMaxCount} attachments on a message`);
      if (new Set(ids).size !== ids.length) throw new Error("the same upload is listed twice");
      if (!message.text.trim() && !ids.length) throw new Error("empty message: write something or attach a file");
      const files = ids.map((id) => {
        const a = this.store.getArtifact(id);
        if (!a || a.uploadedBy !== HUMAN) throw new Error("no such human upload");
        if (a.messageId != null) throw new Error("upload is already attached to a message");
        return a;
      });
      const m = this.store.addMessage(message);
      for (const a of files) this.store.attachArtifact(a.id, m.id);
      return m;
    })();
  }

  /** Human files are readable only in the addressed DM or the agent's own workspace Room. */
  canReadHumanAttachment(agent: Agent, art: Artifact): boolean {
    if (this.isExternal(agent) || agent.quarantined || art.messageId == null) return false;
    const m = this.store.messageById(art.messageId);
    return !!m && m.from === HUMAN && (m.thread === roomOf(agent.workspaceId) || m.thread === "dm:" + [agent.id, HUMAN].sort().join(":"));
  }

  humanDm(agentNameOrId: string, text: string, attachments: string[] = [], requestId?: string): Message {
    const agent = this.resolveAgent(agentNameOrId);
    if (attachments.length && this.isExternal(agent)) throw new Error("human attachments cannot be sent to outside agents");
    const thread = "dm:" + [agent.id, HUMAN].sort().join(":");
    let msgText = text;
    if (requestId) {
      const req = this.store.getRequest(requestId);
      if (req) {
        const msgs = this.store.messagesSince(thread, 0);
        const tag = `Discussing request ${req.id}`;
        const alreadyDiscussed = msgs.some((m) => m.text.includes(tag));
        if (!alreadyDiscussed && !text.includes(tag)) {
          const shortText = req.text.trim().replace(/\r?\n+/g, " ");
          msgText = `Discussing request ${req.id}: ${shortText}\n\n${text}`;
        }
      }
    }
    const m = this.humanMessage({ thread, from: HUMAN, text: msgText }, attachments);
    this.notify();
    return m;
  }
  humanCreateTask(t: { title: string; project: string; assignee?: string; description?: string; acceptance?: string; needsPreview?: boolean; workspaceId?: string; backlog?: boolean }): Task {
    // Backlog and an assignee contradict each other: assignment is what opens a backlog task to one agent.
    if (t.backlog && t.assignee) throw new Error("a backlog task cannot be assigned; create it in Backlog, then assign it from its page to open it for one agent");
    // An existing project decides its workspace; a new one is created in the workspace the human is looking at.
    const existing = this.store.projectWorkspace(t.project);
    if (existing && t.workspaceId && existing !== t.workspaceId)
      throw new Error(`project ${t.project} belongs to workspace ${this.store.getWorkspace(existing)?.name ?? existing}; pick that workspace, or a different project name`);
    const wsId = existing ?? t.workspaceId ?? "default";
    if (!this.store.getWorkspace(wsId)) throw new Error("no workspace with that id");
    const assigned = t.assignee ? this.resolveAgent(t.assignee) : null;
    if (assigned && !this.isExternal(assigned) && assigned.workspaceId !== wsId)
      throw new Error(`${assigned.name} works in workspace ${this.store.getWorkspace(assigned.workspaceId)?.name}, but ${t.project} belongs to ${this.store.getWorkspace(wsId)?.name}`);
    this.store.ensureProject(t.project, wsId);
    const assignee = assigned?.id;
    const task = this.store.addTask({ title: t.title, project: t.project, createdBy: HUMAN, aiGenerated: false, assignee, description: t.description?.trim() || undefined, acceptance: t.acceptance?.trim() || undefined, previewRequired: !!t.needsPreview, status: t.backlog ? "backlog" : "open" });
    this.event(task.id, HUMAN, "created", t.backlog ? "created in backlog by the human; no agent can see it yet" : "created by the human");
    this.notify();
    return task;
  }

  // Reads what is new for this agent without consuming it. Items stay pending until the agent
  // acknowledges them (see waitForWork), so a wait the client abandoned cannot swallow work.
  private scan(agent: Agent): WaitResult {
    const items: WorkItem[] = [];
    const sender = new Map<string, Agent | null>();
    const who = (id: string) => { if (!sender.has(id)) sender.set(id, id === HUMAN ? null : this.store.agentById(id)); return sender.get(id)!; };
    const by = (id: string): Sender => { const a = who(id); return a ? { name: a.name, owner: a.owner } : { name: "human", owner: this.hubOwner || "human" }; };
    const trustOf = (fromId: string, tainted: boolean): Trust => {
      const a = who(fromId);
      if (a && this.isExternal(a)) return "external";
      return tainted ? "tainted" : "owner";
    };
    const cur = this.store.getCursors(agent.id);

    let taskCursor = cur.task;
    for (const t of this.store.tasksAfter(cur.task)) {
      taskCursor = Math.max(taskCursor, t.seq);
      const forMe = t.assignee === agent.id || (t.assignee === null && t.createdBy !== agent.id);
      if (forMe && t.status === "open" && !this.store.wasInterrupted(agent.id, "task", t.id, t.seq) && this.canAccessTask(agent, t)) items.push({ type: "task", task: this.taskForAgent(t, agent), trust: trustOf(t.createdBy, t.tainted), by: by(t.createdBy) });
    }

    let msgCursor = cur.msg;
    for (const m of this.store.messagesAnySince(cur.msg)) {
      msgCursor = Math.max(msgCursor, m.id);
      if (m.from === agent.id || this.store.wasInterrupted(agent.id, "message", String(m.id), m.id)) continue;
      if (this.recipientsOf(m).some((r) => r.id === agent.id)) items.push({ type: "message", message: { ...m, attachments: this.store.artifactsOfMessage(m.id).filter((a) => a.uploadedBy !== HUMAN || this.canReadHumanAttachment(agent, a)).map(({ id, name, size, mime, kind }) => ({ id, name, size, mime, kind })) }, trust: trustOf(m.from, m.tainted), by: by(m.from) });
    }

    const answers = this.store.undeliveredAnswers(agent.id).filter((r) => !r.taskId || this.canReadTaskRef(agent, r.taskId));
    for (const r of answers) items.push({ type: "answer", request: r, trust: "owner", by: by(HUMAN) });

    // With nothing to deliver, skipping past irrelevant history is safe and keeps scans short.
    if (items.length === 0 && (taskCursor !== cur.task || msgCursor !== cur.msg)) {
      this.store.setCursors(agent.id, { msg: msgCursor, task: taskCursor });
    }
    return { items, ack: { msg: msgCursor, task: taskCursor, answers: answers.map((r) => r.id) } };
  }

  private applyAck(agent: Agent, ack: Ack) {
    const cur = this.store.getCursors(agent.id);
    for (const it of ack.interrupted ?? []) this.store.skipInterrupted(agent.id, it.type, it.id, it.seq);
    const msg = Math.max(cur.msg, ack.msg);
    const task = Math.max(cur.task, ack.task);
    if (msg !== cur.msg || task !== cur.task) { this.store.setCursors(agent.id, { msg, task }); this.notify(); }   // the UI shows "read" as soon as the turn is confirmed
    this.ackAnswers(agent, ack.answers);
    this.store.pruneInterrupted(agent.id, msg, task);
  }

  /** Non-blocking read of pending work. Applies `ack` first; unacknowledged items come back again. */
  pull(agent: Agent, ack?: Ack): WaitResult {
    this.store.touchAgent(agent.id);
    if (ack) this.applyAck(agent, ack);
    const result = this.scan(agent);
    this.markDelivered(agent, result);
    return result;
  }

  /** Resolves with new work, or empty at the timeout or when `signal` aborts. Pass the returned
   * `ack` to the next call to confirm receipt; unacknowledged items are delivered again. */
  waitForWork(agent: Agent, timeoutMs: number, ack?: Ack, signal?: AbortSignal): Promise<WaitResult> {
    this.store.touchAgent(agent.id);
    if (ack) this.applyAck(agent, ack);
    const now = this.scan(agent);
    if (now.items.length > 0 || signal?.aborted) { this.markDelivered(agent, now); return Promise.resolve(now); }

    return new Promise((resolve) => {
      let done = false;
      let off = () => {};
      const finish = (result: WaitResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        off();
        resolve(result);
      };
      const empty = () => ({ items: [] as WorkItem[], ack: this.scan(agent).ack });
      const onAbort = () => finish(empty());
      const timer = setTimeout(() => finish(empty()), timeoutMs);
      signal?.addEventListener("abort", onAbort);
      off = this.onChange(() => {
        const result = this.scan(agent);
        if (result.items.length > 0) { this.markDelivered(agent, result); finish(result); }
      });
    });
  }
}
