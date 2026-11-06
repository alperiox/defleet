import { scheduleStore } from "./schedules";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { knowledgeStore } from "./knowledge";
import { digestMatches } from "./auth";

export type TaskStatus = "backlog" | "open" | "claimed" | "in_progress" | "blocked" | "done";
export type RequestKind = "decision" | "session" | "approval" | "dispute" | "handoff";

export interface Agent { id: string; name: string; owner: string; device: string; skills: string[]; lastSeen: number; workspaceId: string; deviceId: string | null; role: string; /** standing instructions from the human, shown to the agent every turn */ instructions: string; /** when this agent's token stops working (an outside agent's invite can expire); null means never */ expiresAt: number | null; /** set by the MCP layer for a quarantined turn; never stored */ quarantined?: boolean }
export interface Device { id: string; name: string; lastSeen: number; info: { hostname?: string; harnesses?: { id: string; label: string; path: string | null }[]; roots?: string[]; models?: Record<string, string[]>; /** Where each model list came from, or why it is empty: the UI says so instead of showing a blank list. */ modelInfo?: Record<string, { source?: string; found?: number; at?: number; error?: string }>; sessions?: { harness: string; id: string; dir: string; modified: number; preview: string }[]; /** Subscription usage per harness, measured on the device. */ usage?: Record<string, unknown>; /** Rises on every local device change; a report with a lower revision is stale and ignored. */ rev?: number; } }
export type DeviceRequestStatus = "pending" | "delivered" | "awaiting-confirmation" | "done" | "failed";
export interface DeviceRequest { id: string; deviceId: string; kind: string; payload: Record<string, any>; status: DeviceRequestStatus; message: string | null; agentId: string | null; needsConfirmation: boolean; createdAt: number; updatedAt: number }
export interface Workspace { id: string; name: string; createdAt: number }
export interface Task {
  id: string; title: string; project: string; visibleToAgent: string | null; parentId: string | null; createdBy: string;
  aiGenerated: boolean; status: TaskStatus; claimedBy: string | null; assignee: string | null; note: string | null; createdAt: number; seq: number;
  key: string; description: string | null; acceptance: string | null; outcomeRequired: boolean; previewRequired: boolean; claimedAt: number | null; tainted: boolean;
  /** Set while the task is offered, not ordered: who offered it, and when. */
  offerBy: string | null; offerAt: number | null; /** the latest handoff brief */ handoff: string | null;
}
export type ArtifactKind = "report" | "screenshot" | "video" | "file";
export interface Artifact { id: string; taskId: string; kind: ArtifactKind; name: string; mime: string; size: number; uploadedBy: string; createdAt: number; messageId: number | null }
export interface TaskEvent { id: number; taskId: string; actor: string; kind: string; text: string; createdAt: number }
export interface Evidence { id: number; taskId: string; kind: string; ref: string; note: string | null }
export interface Message { attachments?: { id: string; name: string; size: number; mime: string; kind: ArtifactKind }[]; id: number; thread: string; from: string; text: string; createdAt: number; tainted: boolean; replyToAgent?: string | null }
export interface Request {
  id: string; fromAgent: string; owner: string; kind: RequestKind; text: string;
  link: string | null; taskId: string | null; answer: string | null; delivered: boolean; createdAt: number; withAgent: string | null; tainted: boolean;
}
export interface Touch { id: number; agentId: string; action: string; target: string; source: "hub" | "declared" | "human"; createdAt: number }

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, device TEXT NOT NULL,
  skills TEXT NOT NULL, token TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0,
  msg_cursor INTEGER NOT NULL DEFAULT 0, task_cursor INTEGER NOT NULL DEFAULT 0, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS interrupted_items (
  agent_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (agent_id, kind, ref, seq));
CREATE TABLE IF NOT EXISTS task_wake_counter (id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS task_deletions (
  task_id TEXT PRIMARY KEY, task_key TEXT NOT NULL, title TEXT NOT NULL, workspace_id TEXT NOT NULL,
  actor TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'deleted', created_at INTEGER NOT NULL,
  pending_files TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL, parent_id TEXT, created_by TEXT NOT NULL,
  ai_generated INTEGER NOT NULL, status TEXT NOT NULL, claimed_by TEXT, assignee TEXT, note TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  link TEXT, task_id TEXT, answer TEXT, delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id);
CREATE TABLE IF NOT EXISTS agent_projects (
  agent_id TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (agent_id, project));
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_name ON workspaces(lower(name));
CREATE TABLE IF NOT EXISTS integrations (id INTEGER PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, from_sha TEXT NOT NULL, to_sha TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0, info TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS device_requests (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, message TEXT,
  agent_id TEXT, needs_confirmation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS device_requests_device ON device_requests(device_id, status);
CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  source TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

const now = () => Date.now();
const keyPrefix = (project: string) => (project.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "TASK");

export function openStore(path: string, options: { knowledgeFts?: boolean } = {}) {
  const db = new Database(path, { create: true });
  // Bound lock contention from the hub and admin CLI on every connection.
  db.run("PRAGMA busy_timeout=5000");
  db.run("PRAGMA journal_mode=WAL");
  db.run(SCHEMA);

  // Older databases lack the newer columns. Add them in place, then give every existing task a key.
  const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const addColumn = (table: string, col: string, type: string) => { if (!columns(table).includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); };
  addColumn("workspaces", "visibility", "TEXT NOT NULL DEFAULT 'owner'");
  addColumn("messages", "reply_to_agent", "TEXT");
  addColumn("artifacts", "message_id", "INTEGER");
  db.run("CREATE INDEX IF NOT EXISTS artifacts_message ON artifacts(message_id)");
  addColumn("agents", "role", "TEXT");
  addColumn("agents", "instructions", "TEXT");
  addColumn("tasks", "visible_to_agent", "TEXT");
  addColumn("tasks", "wake_seq", "INTEGER");
  // Legacy rows get a sequence once. A backlog row is born without one on purpose (it must not move a cursor) and must
  // stay that way across restarts until it is opened or assigned.
  db.run("UPDATE tasks SET wake_seq = rowid WHERE wake_seq IS NULL AND status <> 'backlog'");
  db.run("CREATE INDEX IF NOT EXISTS tasks_wake_seq ON tasks(wake_seq)");
  db.run("INSERT OR IGNORE INTO task_wake_counter (id, value) VALUES (1, 0)");
  db.run("UPDATE task_wake_counter SET value = MAX(value, COALESCE((SELECT MAX(wake_seq) FROM tasks), 0), COALESCE((SELECT MAX(task_cursor) FROM agents), 0)) WHERE id = 1");
  const activate = (id: string) => {
    const r = db.query("UPDATE task_wake_counter SET value = value + 1 WHERE id = 1 RETURNING value").get() as { value: number };
    db.query("UPDATE tasks SET wake_seq = ? WHERE id = ?").run(r.value, id);
  };
  addColumn("tasks", "offer_by", "TEXT");
  addColumn("tasks", "offer_at", "INTEGER");
  addColumn("tasks", "handoff", "TEXT");
  addColumn("tasks", "description", "TEXT");
  addColumn("tasks", "acceptance", "TEXT");
  addColumn("tasks", "key", "TEXT");
  addColumn("requests", "with_agent", "TEXT");
  addColumn("tasks", "outcome_required", "INTEGER NOT NULL DEFAULT 0");
  addColumn("tasks", "preview_required", "INTEGER NOT NULL DEFAULT 0");
  addColumn("agents", "workspace_id", "TEXT");
  addColumn("agents", "device_id", "TEXT");
  addColumn("agents", "expires_at", "INTEGER");
  // Every install has one workspace from the start. Agents and projects that existed before workspaces belong to it, and the original room is its room.
  db.run("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('default', 'Default', 0)");
  db.run("UPDATE agents SET workspace_id = 'default' WHERE workspace_id IS NULL");
  db.run("INSERT OR IGNORE INTO projects (name, workspace_id, created_at) SELECT DISTINCT project, 'default', 0 FROM tasks");
  addColumn("tasks", "claimed_at", "INTEGER");
  db.run("UPDATE tasks SET claimed_at = created_at WHERE claimed_by IS NOT NULL AND claimed_at IS NULL");
  addColumn("tasks", "tainted", "INTEGER NOT NULL DEFAULT 0");
  addColumn("messages", "tainted", "INTEGER NOT NULL DEFAULT 0");
  addColumn("requests", "tainted", "INTEGER NOT NULL DEFAULT 0");
  const nextKey = (project: string) => {
    const prefix = keyPrefix(project);
    const rows = db.query("SELECT key FROM tasks WHERE key LIKE ? UNION ALL SELECT task_key AS key FROM task_deletions WHERE task_key LIKE ?").all(`${prefix}-%`, `${prefix}-%`) as { key: string }[];
    const n = rows.reduce((max, row) => Math.max(max, Number(row.key.split("-").pop()) || 0), 0);
    return `${prefix}-${n + 1}`;
  };
  for (const r of db.query("SELECT id, project FROM tasks WHERE key IS NULL ORDER BY rowid").all() as { id: string; project: string }[]) {
    db.query("UPDATE tasks SET key = ? WHERE id = ?").run(nextKey(r.project), r.id);
  }
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS tasks_key ON tasks(key)");

  const toAgent = (r: any): Agent => ({
    id: r.id, name: r.name, owner: r.owner, device: r.device, skills: JSON.parse(r.skills), lastSeen: r.last_seen, workspaceId: r.workspace_id ?? "default", deviceId: r.device_id ?? null, role: r.role ?? "", instructions: r.instructions ?? "",
    expiresAt: r.expires_at ?? null,
  });
  const toTask = (r: any): Task => ({
    id: r.id, title: r.title, project: r.project, visibleToAgent: r.visible_to_agent ?? null, parentId: r.parent_id, createdBy: r.created_by,
    aiGenerated: !!r.ai_generated, status: r.status, claimedBy: r.claimed_by, assignee: r.assignee, note: r.note, createdAt: r.created_at, seq: r.seq,
    key: r.key, description: r.description, acceptance: r.acceptance, outcomeRequired: !!r.outcome_required, previewRequired: !!r.preview_required, claimedAt: r.claimed_at ?? null, tainted: !!r.tainted,
    offerBy: r.offer_by ?? null, offerAt: r.offer_at ?? null, handoff: r.handoff ?? null,
  });
  const toDevice = (r: any): Device => ({ id: r.id, name: r.name, lastSeen: r.last_seen, info: JSON.parse(r.info) });
  const toDeviceRequest = (r: any): DeviceRequest => ({ id: r.id, deviceId: r.device_id, kind: r.kind, payload: JSON.parse(r.payload), status: r.status, message: r.message, agentId: r.agent_id, needsConfirmation: !!r.needs_confirmation, createdAt: r.created_at, updatedAt: r.updated_at });
  const toMessage = (r: any): Message => ({ id: r.id, thread: r.thread, from: r.sender, text: r.text, createdAt: r.created_at, tainted: !!r.tainted, replyToAgent: r.reply_to_agent ?? null });
  const toRequest = (r: any): Request => ({
    id: r.id, fromAgent: r.from_agent, owner: r.owner, kind: r.kind, text: r.text, link: r.link,
    taskId: r.task_id, answer: r.answer, delivered: !!r.delivered, createdAt: r.created_at, withAgent: r.with_agent ?? null, tainted: !!r.tainted,
  });

  return {
    ...scheduleStore(db),
    dbPath: path,
    ...knowledgeStore(db, options.knowledgeFts),
    db,

    addAgent(a: { name: string; owner: string; device: string; skills: string[]; workspaceId?: string; deviceId?: string; expiresAt?: number | null }) {
      const id = crypto.randomUUID();
      const token = randomBytes(32).toString("hex");
      // Only the hash is stored; the raw token is shown once and cannot be recovered from the DB or its backups.
      db.query("INSERT INTO agents (id,name,owner,device,skills,token,workspace_id,device_id,expires_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, a.name, a.owner, a.device, JSON.stringify(a.skills), hashToken(token), a.workspaceId ?? "default", a.deviceId ?? null, a.expiresAt ?? null);
      return { id, token };
    },
    // ---- devices: machines that can be asked to start agents ----
    addDevice(name: string): { id: string; token: string } {
      const id = crypto.randomUUID(), token = randomBytes(32).toString("hex");
      db.query("INSERT INTO devices (id,name,token,created_at) VALUES (?,?,?,?)").run(id, name, hashToken(token), now());
      return { id, token };
    },
    deviceByToken(token: string): Device | null {
      const digest = hashToken(token);
      const r = db.query("SELECT * FROM devices WHERE token = ? AND revoked = 0").get(digest) as any;
      const matches = digestMatches(digest, r?.token);
      return matches && r ? toDevice(r) : null;
    },
    getDevice(id: string): Device | null {
      const r = db.query("SELECT * FROM devices WHERE id = ? AND revoked = 0").get(id);
      return r ? toDevice(r) : null;
    },
    listDevices(): Device[] {
      return db.query("SELECT * FROM devices WHERE revoked = 0 ORDER BY created_at").all().map(toDevice);
    },
    touchDevice(id: string, info?: Device["info"]) {
      if (info) db.query("UPDATE devices SET last_seen = ?, info = ? WHERE id = ?").run(now(), JSON.stringify(info), id);
      else db.query("UPDATE devices SET last_seen = ? WHERE id = ?").run(now(), id);
    },
    revokeDevice(id: string): boolean {
      return db.query("UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0").run(id).changes > 0;
    },
    agentsOfDevice(deviceId: string): Agent[] {
      return db.query("SELECT * FROM agents WHERE device_id = ? AND revoked = 0").all(deviceId).map(toAgent);
    },
    addDeviceRequest(r: { deviceId: string; kind: string; payload: Record<string, any>; agentId?: string; needsConfirmation?: boolean }): DeviceRequest {
      const id = crypto.randomUUID();
      db.query("INSERT INTO device_requests (id,device_id,kind,payload,status,agent_id,needs_confirmation,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?,?)")
        .run(id, r.deviceId, r.kind, JSON.stringify(r.payload), r.agentId ?? null, r.needsConfirmation ? 1 : 0, now(), now());
      return this.getDeviceRequest(id)!;
    },
    getDeviceRequest(id: string): DeviceRequest | null {
      const r = db.query("SELECT * FROM device_requests WHERE id = ?").get(id);
      return r ? toDeviceRequest(r) : null;
    },
    /** What a device still has to do: not yet delivered, delivered but unfinished, or waiting for a person at the device. */
    openDeviceRequests(deviceId: string): DeviceRequest[] {
      return db.query("SELECT * FROM device_requests WHERE device_id = ? AND status IN ('pending','delivered','awaiting-confirmation') ORDER BY created_at").all(deviceId).map(toDeviceRequest);
    },
    listDeviceRequests(limit = 50): DeviceRequest[] {
      return db.query("SELECT * FROM device_requests ORDER BY created_at DESC LIMIT ?").all(limit).map(toDeviceRequest).reverse();
    },
    setDeviceRequest(id: string, status: DeviceRequestStatus, message?: string) {
      // Once a request is finished the agent's token has no business staying in the database.
      if (status === "done" || status === "failed") {
        const r = this.getDeviceRequest(id);
        if (r) { const { token: _t, ...rest } = r.payload; db.query("UPDATE device_requests SET payload = ? WHERE id = ?").run(JSON.stringify(rest), id); }
      }
      db.query("UPDATE device_requests SET status = ?, message = ?, updated_at = ? WHERE id = ?").run(status, message ?? null, now(), id);
    },
    listWorkspaces(): Workspace[] {
      return db.query("SELECT * FROM workspaces ORDER BY created_at, name").all().map((r: any) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
    },
    getWorkspace(id: string): Workspace | null {
      const r: any = db.query("SELECT * FROM workspaces WHERE id = ?").get(id);
      return r ? { id: r.id, name: r.name, createdAt: r.created_at } : null;
    },
    workspaceByName(name: string): Workspace | null {
      const r: any = db.query("SELECT * FROM workspaces WHERE lower(name) = lower(?)").get(name.trim());
      return r ? { id: r.id, name: r.name, createdAt: r.created_at } : null;
    },
    defaultWorkspace(): Workspace { return this.getWorkspace("default")!; },
    addWorkspace(name: string): Workspace {
      const id = crypto.randomUUID();
      db.query("INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)").run(id, name, now());
      return this.getWorkspace(id)!;
    },
    renameWorkspace(id: string, name: string) { db.query("UPDATE workspaces SET name = ? WHERE id = ?").run(name, id); },
    setAgentWorkspace(agentId: string, workspaceId: string) { db.query("UPDATE agents SET workspace_id = ? WHERE id = ?").run(workspaceId, agentId); },
    projectWorkspace(project: string): string | null {
      const r: any = db.query("SELECT workspace_id FROM projects WHERE name = ?").get(project);
      return r ? r.workspace_id : null;
    },
    /** Registers a project in a workspace the first time it is used. An existing project keeps the workspace it has. */
    projectCreated: undefined as undefined | ((project:string)=>void),
    addIntegration(r:{project:string;branch:string;fromSha:string;toSha:string;actor:string;createdAt:number}) { db.query("INSERT INTO integrations(project,branch,from_sha,to_sha,actor,created_at) VALUES (?,?,?,?,?,?)").run(r.project,r.branch,r.fromSha,r.toSha,r.actor,r.createdAt); },
    listIntegrations(project:string): {project:string;branch:string;fromSha:string;toSha:string;actor:string;createdAt:number}[] { return db.query("SELECT project,branch,from_sha AS fromSha,to_sha AS toSha,actor,created_at AS createdAt FROM integrations WHERE project=? ORDER BY id DESC").all(project) as any; },
    ensureProject(project: string, workspaceId: string) {
      db.query("INSERT OR IGNORE INTO projects (name, workspace_id, created_at) VALUES (?,?,?)").run(project, workspaceId, now());
      this.projectCreated?.(project);
    },
    listProjects(): { name: string; workspaceId: string }[] {
      return db.query("SELECT * FROM projects ORDER BY name").all().map((r: any) => ({ name: r.name, workspaceId: r.workspace_id }));
    },
    setAgentDevice(agentId: string, deviceName: string, deviceId: string) {
      db.query("UPDATE agents SET device = ?, device_id = ? WHERE id = ?").run(deviceName, deviceId, agentId);
    },
    /** Replaces an active agent's token (the old one stops working at once). Returns the new token, shown once, or null. */
    rotateAgentToken(name: string): { id: string; token: string } | null {
      const row: any = db.query("SELECT id FROM agents WHERE name = ? AND revoked = 0").get(name);
      if (!row) return null;
      const token = randomBytes(32).toString("hex");
      db.query("UPDATE agents SET token = ? WHERE id = ?").run(hashToken(token), row.id);
      return { id: row.id, token };
    },
    agentByToken(token: string): Agent | null {
      const digest = hashToken(token);
      // An expired invite stops working at once, not at the next restart: the clock is checked on every lookup.
      const r = db.query("SELECT * FROM agents WHERE token = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)").get(digest, now()) as any;
      const matches = digestMatches(digest, r?.token);
      return matches && r ? toAgent(r) : null;
    },
    revokeAgent(name: string): boolean {
      // The name is released (so a replacement can use it) and the old record stays, labelled, so history still reads.
      return db.query("UPDATE agents SET revoked = 1, name = name || '~revoked~' || substr(id, 1, 8) WHERE name = ? AND revoked = 0").run(name).changes > 0;
    },
    agentById(id: string): Agent | null {
      const r = db.query("SELECT * FROM agents WHERE id = ?").get(id);
      return r ? toAgent(r) : null;
    },
    /** Agents that can act. Removed ones are not listed: they cannot be mentioned, messaged or counted as recipients. */
    listAgents(): Agent[] {
      return db.query("SELECT * FROM agents WHERE revoked = 0 ORDER BY name").all().map(toAgent);
    },
    /** Removed agents, only so old messages and task history can still say who wrote them. */
    listRetiredAgents(): { id: string; name: string }[] {
      return db.query("SELECT id, name FROM agents WHERE revoked = 1").all().map((r: any) => ({ id: r.id, name: String(r.name).replace(/~revoked~.*$/, "") }));
    },
    skipInterrupted(agentId: string, kind: string, ref: string, seq: number) {
      db.query("INSERT OR IGNORE INTO interrupted_items (agent_id,kind,ref,seq) VALUES (?,?,?,?)").run(agentId, kind, ref, seq);
    },
    wasInterrupted(agentId: string, kind: string, ref: string, seq: number): boolean {
      return !!db.query("SELECT 1 FROM interrupted_items WHERE agent_id = ? AND kind = ? AND ref = ? AND seq = ?").get(agentId, kind, ref, seq);
    },
    pruneInterrupted(agentId: string, msg: number, task: number) {
      db.query("DELETE FROM interrupted_items WHERE agent_id = ? AND ((kind = 'message' AND seq <= ?) OR (kind = 'task' AND seq <= ?))").run(agentId, msg, task);
    },
    getCursors(agentId: string): { msg: number; task: number } {
      const r = db.query("SELECT msg_cursor, task_cursor FROM agents WHERE id = ?").get(agentId) as any;
      return { msg: r?.msg_cursor ?? 0, task: r?.task_cursor ?? 0 };
    },
    setCursors(agentId: string, c: { msg: number; task: number }) {
      db.query("UPDATE agents SET msg_cursor = ?, task_cursor = ? WHERE id = ?").run(c.msg, c.task, agentId);
    },
    touchAgent(id: string) {
      db.query("UPDATE agents SET last_seen = ? WHERE id = ?").run(now(), id);
    },

    /** `status: "backlog"` inserts the row already hidden and gives it no wake sequence, so creating it never wakes an
     * agent or moves a cursor; opening or assigning it later calls activateTask and hands it a fresh sequence. */
    addTask(t: { title: string; project: string; parentId?: string; createdBy: string; aiGenerated: boolean; assignee?: string; description?: string; acceptance?: string; tainted?: boolean; previewRequired?: boolean; status?: TaskStatus }): Task {
      const id = crypto.randomUUID(), status = t.status ?? "open";
      db.query("INSERT INTO tasks (id,title,project,parent_id,created_by,ai_generated,status,assignee,created_at,key,description,acceptance,tainted,preview_required) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, t.title, t.project, t.parentId ?? null, t.createdBy, t.aiGenerated ? 1 : 0, status, t.assignee ?? null, now(),
          nextKey(t.project), t.description ?? null, t.acceptance ?? null, t.tainted ? 1 : 0, t.previewRequired ? 1 : 0);
      if (status !== "backlog") activate(id);
      return this.getTask(id)!;
    },
    getTask(id: string): Task | null {
      const r = db.query("SELECT *, wake_seq AS seq FROM tasks WHERE id = ?").get(id);
      return r ? toTask(r) : null;
    },
    /** Finds a task by full id, key (KAPI-12, any case) or a unique id prefix of at least 6 hex characters. */
    resolveTask(ref: string): Task | null {
      const r = ref.trim();
      if (!r) return null;
      const exact = db.query("SELECT *, wake_seq AS seq FROM tasks WHERE id = ? OR key = ?").get(r, r.toUpperCase());
      if (exact) return toTask(exact);
      if (r.length >= 6 && /^[0-9a-f-]+$/i.test(r)) {
        const rows = db.query("SELECT *, wake_seq AS seq FROM tasks WHERE id LIKE ?").all(`${r.toLowerCase()}%`);
        if (rows.length === 1) return toTask(rows[0]);
      }
      return null;
    },
    childrenOf(id: string): Task[] {
      return db.query("SELECT *, wake_seq AS seq FROM tasks WHERE parent_id = ? ORDER BY rowid").all(id).map(toTask);
    },
    setPreviewRequired(id: string, required: boolean) {
      db.query("UPDATE tasks SET preview_required = ? WHERE id = ?").run(required ? 1 : 0, id);
    },
    setOutcomeRequired(id: string, required: boolean) {
      db.query("UPDATE tasks SET outcome_required = ? WHERE id = ?").run(required ? 1 : 0, id);
    },
    addArtifact(a: { id: string; taskId: string | null; kind: ArtifactKind; name: string; mime: string; size: number; uploadedBy: string }): Artifact {
      db.query("INSERT INTO artifacts (id,task_id,kind,name,mime,size,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(a.id, a.taskId ?? "", a.kind, a.name, a.mime, a.size, a.uploadedBy, now());
      return this.getArtifact(a.id)!;
    },
    getArtifact(id: string): Artifact | null {
      return (db.query("SELECT id, task_id AS taskId, kind, name, mime, size, uploaded_by AS uploadedBy, created_at AS createdAt, message_id AS messageId FROM artifacts WHERE id = ?").get(id) as Artifact) ?? null;
    },
    artifactsFor(taskId?: string): Artifact[] {
      const base = "SELECT id, task_id AS taskId, kind, name, mime, size, uploaded_by AS uploadedBy, created_at AS createdAt, message_id AS messageId FROM artifacts";
      return (taskId ? db.query(base + " WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) : db.query(base + " ORDER BY created_at, rowid").all()) as Artifact[];
    },
    messageById(id: number): Message | null {
      const row = db.query("SELECT * FROM messages WHERE id = ?").get(id);
      return row ? toMessage(row) : null;
    },
    artifactsOfMessage(id: number): Artifact[] {
      return db.query("SELECT id, task_id AS taskId, kind, name, mime, size, uploaded_by AS uploadedBy, created_at AS createdAt, message_id AS messageId FROM artifacts WHERE message_id = ? ORDER BY created_at, rowid").all(id) as Artifact[];
    },
    /** Files an agent uploaded that no message or task uses yet. */
    unattachedBy(agentId: string): number {
      return (db.query("SELECT COUNT(*) AS n FROM artifacts WHERE uploaded_by = ? AND message_id IS NULL AND task_id = ''").get(agentId) as any).n;
    },
    attachArtifact(id: string, messageId: number, taskId?: string) {
      db.query("UPDATE artifacts SET message_id = ?, task_id = COALESCE(?, task_id) WHERE id = ?").run(messageId, taskId ?? null, id);
    },
    grantProject(agentId: string, project: string) {
      db.query("INSERT OR IGNORE INTO agent_projects (agent_id, project) VALUES (?, ?)").run(agentId, project);
    },
    revokeProject(agentId: string, project: string) {
      db.query("DELETE FROM agent_projects WHERE agent_id = ? AND project = ?").run(agentId, project);
    },
    projectsOf(agentId: string): string[] {
      return (db.query("SELECT project FROM agent_projects WHERE agent_id = ? ORDER BY project").all(agentId) as { project: string }[]).map((r) => r.project);
    },
    addTaskEvent(e: { taskId: string; actor: string; kind: string; text: string }) {
      db.query("INSERT INTO task_events (task_id,actor,kind,text,created_at) VALUES (?,?,?,?,?)").run(e.taskId, e.actor, e.kind, e.text, now());
    },
    taskEvents(taskId?: string): TaskEvent[] {
      const base = "SELECT id, task_id AS taskId, actor, kind, text, created_at AS createdAt FROM task_events";
      return (taskId ? db.query(base + " WHERE task_id = ? ORDER BY id").all(taskId) : db.query(base + " ORDER BY id").all()) as TaskEvent[];
    },
    listTasks(project?: string): Task[] {
      const rows = project
        ? db.query("SELECT *, wake_seq AS seq FROM tasks WHERE project = ? ORDER BY rowid").all(project)
        : db.query("SELECT *, wake_seq AS seq FROM tasks ORDER BY rowid").all();
      return rows.map(toTask);
    },
    tasksAfter(seq: number): Task[] {
      return db.query("SELECT *, wake_seq AS seq FROM tasks WHERE wake_seq > ? ORDER BY wake_seq").all(seq).map(toTask);
    },
    claimTask(id: string, agentId: string): Task {
      const existing = this.getTask(id);
      if (existing?.assignee && existing.assignee !== agentId) throw new Error("assigned to another agent");
      const res = db.query("UPDATE tasks SET claimed_by = ?, status = 'claimed', claimed_at = ?, offer_by = NULL, offer_at = NULL WHERE id = ? AND claimed_by IS NULL").run(agentId, now(), id);
      if (res.changes === 0) {
        if (!this.getTask(id)) throw new Error("no such task");
        throw new Error("already claimed");
      }
      return this.getTask(id)!;
    },
    /** Moves a held task to another agent (its lease expired). */
    takeOverTask(id: string, agentId: string): Task {
      db.query("UPDATE tasks SET claimed_by = ?, claimed_at = ?, status = 'claimed' WHERE id = ?").run(agentId, now(), id);
      return this.getTask(id)!;
    },
    /** Gives a task back. The brief (if any) stays on the task for the next holder; an offer is recorded when `offeredBy` is given. */
    releaseTask(id: string, assignee?: string | null, brief?: string, offeredBy?: string): Task {
      const offer = offeredBy && assignee ? [offeredBy, now()] : [null, null];
      if (assignee === undefined) {
        db.query("UPDATE tasks SET claimed_by = NULL, claimed_at = NULL, status = 'open', offer_by = NULL, offer_at = NULL, handoff = COALESCE(?, handoff) WHERE id = ?").run(brief ?? null, id);
      } else {
        db.query("UPDATE tasks SET claimed_by = NULL, claimed_at = NULL, status = 'open', assignee = ?, offer_by = ?, offer_at = ?, handoff = COALESCE(?, handoff) WHERE id = ?").run(assignee, offer[0], offer[1], brief ?? null, id);
      }
      return this.getTask(id)!;
    },
    setOffer(id: string, by: string) {
      db.query("UPDATE tasks SET offer_by = ?, offer_at = ? WHERE id = ?").run(by, now(), id);
    },
    /** The assignee said no, or never answered: the task is unassigned again and the offer is gone. */
    clearOffer(id: string): Task {
      db.query("UPDATE tasks SET assignee = NULL, offer_by = NULL, offer_at = NULL WHERE id = ?").run(id);
      return this.getTask(id)!;
    },
    offeredTasks(): Task[] {
      return db.query("SELECT *, wake_seq AS seq FROM tasks WHERE offer_at IS NOT NULL AND claimed_by IS NULL AND status = 'open'").all().map(toTask);
    },
    setInstructions(agentId: string, text: string) {
      db.query("UPDATE agents SET instructions = ? WHERE id = ?").run(text, agentId);
    },
    setRole(agentId: string, role: string) {
      db.query("UPDATE agents SET role = ? WHERE id = ?").run(role, agentId);
    },
    /** What an agent was started with from the UI (tool, model, folder), if it was. */
    launchOf(agentId: string): { harness: string; model?: string; dir: string } | null {
      const r = db.query("SELECT payload FROM device_requests WHERE agent_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1").get(agentId) as any;
      if (!r) return null;
      const p = JSON.parse(r.payload);
      return p.harness ? { harness: p.harness, model: p.model || undefined, dir: p.dir } : null;
    },
    activateTask(id: string) { activate(id); },
    setTaskAudience(id: string, agentId: string | null) {
      db.query("UPDATE tasks SET visible_to_agent = ? WHERE id = ?").run(agentId, id);
    },
    deletedTasks(): { taskId: string; key: string; title: string; workspaceId: string; actor: string; kind: string; createdAt: number; pendingFiles: string[] }[] {
      return (db.query("SELECT task_id AS taskId, task_key AS key, title, workspace_id AS workspaceId, actor, kind, created_at AS createdAt, pending_files FROM task_deletions ORDER BY created_at DESC").all() as any[]).map(({ pending_files, ...r }) => ({ ...r, pendingFiles: JSON.parse(pending_files) }));
    },
    setDeletionPending(id: string, ids: string[]) {
      db.query("UPDATE task_deletions SET pending_files = ? WHERE task_id = ?").run(JSON.stringify(ids), id);
    },
    deleteTaskRecord(task: Task) {
      db.transaction(() => {
        const files = this.artifactsFor(task.id).map((a) => a.id);
        db.query("INSERT INTO task_deletions (task_id, task_key, title, workspace_id, actor, created_at, pending_files) VALUES (?,?,?,?,?,?,?)")
          .run(task.id, task.key, task.title, this.projectWorkspace(task.project) ?? "default", "human", now(), JSON.stringify(files));
        for (const table of ["artifacts", "evidence", "task_events", "requests"]) db.query(`DELETE FROM ${table} WHERE task_id = ?`).run(task.id);
        db.query("DELETE FROM tasks WHERE id = ?").run(task.id);
      })();
    },
    setStatus(id: string, status: TaskStatus, note?: string) {
      db.query("UPDATE tasks SET status = ?, note = COALESCE(?, note) WHERE id = ?").run(status, note ?? null, id);
    },

    addEvidence(taskId: string, e: { kind: string; ref: string; note?: string }) {
      db.query("INSERT INTO evidence (task_id,kind,ref,note) VALUES (?,?,?,?)").run(taskId, e.kind, e.ref, e.note ?? null);
    },
    evidenceFor(taskId: string): Evidence[] {
      return db.query("SELECT id, task_id AS taskId, kind, ref, note FROM evidence WHERE task_id = ? ORDER BY id").all(taskId) as Evidence[];
    },

    addMessage(m: { thread: string; from: string; text: string; tainted?: boolean; replyToAgent?: string }, createdAt = now()): Message {
      const res = db.query("INSERT INTO messages (thread,sender,text,created_at,tainted,reply_to_agent) VALUES (?,?,?,?,?,?)").run(m.thread, m.from, m.text, createdAt, m.tainted ? 1 : 0, m.replyToAgent ?? null);
      return toMessage(db.query("SELECT * FROM messages WHERE id = ?").get(Number(res.lastInsertRowid)));
    },
    latestAgentMessage(thread: string): Message | null {
      const row = db.query("SELECT * FROM messages WHERE thread = ? AND sender != 'human' ORDER BY id DESC LIMIT 1").get(thread);
      return row ? toMessage(row) : null;
    },
    /** Every workspace's room, oldest first. */
    roomMessages(): Message[] {
      return db.query("SELECT * FROM messages WHERE thread = 'room' OR thread LIKE 'room:%' ORDER BY id").all().map(toMessage);
    },
    messagesSince(thread: string, afterId: number): Message[] {
      return db.query("SELECT * FROM messages WHERE thread = ? AND id > ? ORDER BY id").all(thread, afterId).map(toMessage);
    },
    dmsWithHuman(): Message[] {
      return db.query("SELECT * FROM messages WHERE thread LIKE 'dm:%:human' OR thread LIKE 'dm:human:%' ORDER BY id").all().map(toMessage);
    },
    /** Direct threads between two agents, which the human may read but not write to. */
    dmsBetweenAgents(): Message[] {
      return db.query("SELECT * FROM messages WHERE thread LIKE 'dm:%' AND thread NOT LIKE '%:human' AND thread NOT LIKE 'dm:human:%' ORDER BY id").all().map(toMessage);
    },
    allEvidence(): Evidence[] {
      return db.query("SELECT id, task_id AS taskId, kind, ref, note FROM evidence ORDER BY id").all() as Evidence[];
    },
    messagesAnySince(afterId: number): Message[] {
      return db.query("SELECT * FROM messages WHERE id > ? ORDER BY id").all(afterId).map(toMessage);
    },

    addRequest(r: { fromAgent: string; owner: string; kind: RequestKind; text: string; link?: string; taskId?: string; withAgent?: string; tainted?: boolean }): Request {
      const id = crypto.randomUUID();
      db.query("INSERT INTO requests (id,from_agent,owner,kind,text,link,task_id,created_at,with_agent,tainted) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, r.fromAgent, r.owner, r.kind, r.text, r.link ?? null, r.taskId ?? null, now(), r.withAgent ?? null, r.tainted ? 1 : 0);
      return toRequest(db.query("SELECT * FROM requests WHERE id = ?").get(id));
    },
    getRequest(id: string): Request | null {
      const r = db.query("SELECT * FROM requests WHERE id = ?").get(id);
      return r ? toRequest(r) : null;
    },
    answerRequest(id: string, answer: string) {
      const res = db.query("UPDATE requests SET answer = ? WHERE id = ? AND answer IS NULL").run(answer, id);
      if (res.changes === 0) throw new Error("no open request");
    },
    openRequests(): Request[] {
      return db.query("SELECT * FROM requests WHERE answer IS NULL ORDER BY created_at, rowid").all().map(toRequest);
    },
    requestsFor(agentId: string): Request[] {
      return db.query("SELECT * FROM requests WHERE from_agent = ? ORDER BY created_at, rowid").all(agentId).map(toRequest);
    },
    undeliveredAnswers(agentId: string): Request[] {
      return db.query("SELECT * FROM requests WHERE from_agent = ? AND answer IS NOT NULL AND delivered = 0 ORDER BY created_at, rowid")
        .all(agentId).map(toRequest);
    },
    markDelivered(id: string) {
      db.query("UPDATE requests SET delivered = 1 WHERE id = ?").run(id);
    },

    addTouch(t: { agentId: string; action: string; target: string; source: "hub" | "declared" | "human" }) {
      db.query("INSERT INTO touches (agent_id,action,target,source,created_at) VALUES (?,?,?,?,?)")
        .run(t.agentId, t.action, t.target, t.source, now());
    },
    touchesFor(agentId?: string): Touch[] {
      const base = "SELECT id, agent_id AS agentId, action, target, source, created_at AS createdAt FROM touches";
      return (agentId
        ? db.query(base + " WHERE agent_id = ? ORDER BY id").all(agentId)
        : db.query(base + " ORDER BY id").all()) as Touch[];
    },
  };
}

export type Store = ReturnType<typeof openStore>;
