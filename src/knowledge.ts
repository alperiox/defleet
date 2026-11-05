import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { KNOWLEDGE_POLICY as P, KNOWLEDGE_FRAME, knowledgeBlock } from "../shared/knowledge";
export { KNOWLEDGE_POLICY, KNOWLEDGE_FRAME } from "../shared/knowledge";
export type KnowledgeContext = { workspaceId: string; actor: string; human?: boolean; allowed: boolean };
export type KnowledgeSource = { kind: "task" | "message" | "url"; ref: string };
export type KnowledgeInput = { kind: string; title: string; body: string; verify: string; project?: string | null; sources?: KnowledgeSource[] };
const kinds = ["how-to", "fact", "gotcha", "environment"];
const day = 86400000;
function clean(value: unknown, field: string, max: number, multiline = false): string {
 if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
 if ((field === "body" ? Buffer.byteLength(value) : value.length) > max) throw new Error(`${field} exceeds its size limit`);
 if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value) || (!multiline && /[\n\r\t]/.test(value)) || /<\/?[a-z][^>]*>/i.test(value)) throw new Error("HTML and control characters are not allowed");
 scanSecret(value); return value.trim();
}
export function scanSecret(value: string): void {
 const patterns = [/AKIA[0-9A-Z]{16}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /xox[baprs]-/, /sk-[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i];
 if (patterns.some((p) => p.test(value))) throw new Error("Potential secret detected; remove it before publishing knowledge");
 const encodedScan = value.replace(/(\/(?:blob|tree|commit|commits|raw)\/)([a-f0-9]{40})(?=\/|$)/gi, (_all, prefix, hash) => prefix + " ".repeat(hash.length));
 for (const match of encodedScan.matchAll(/[A-Za-z0-9+/_=-]{40,}/g)) {
  const s = match[0], before = value.slice(Math.max(0, match.index! - 24), match.index);
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64}|[a-f0-9]{128})$/i.test(s) && /(?:commit|sha1|sha256|sha512)[ :=]+$/i.test(before)) continue;
  throw new Error("Potential secret detected; long encoded values need a known hash label");
 }
}
export function knowledgeStore(db: Database, enableFts = true) {
 db.run(`CREATE TABLE IF NOT EXISTS knowledge (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project TEXT, scope TEXT NOT NULL, kind TEXT NOT NULL,
 title TEXT NOT NULL, body TEXT NOT NULL, verify TEXT NOT NULL, status TEXT NOT NULL, author_agent_id TEXT NOT NULL,
 approved_by TEXT, approved_at INTEGER, last_verified_at INTEGER, verified_by TEXT, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, failed_verifications INTEGER NOT NULL DEFAULT 0, corrects_entry_id TEXT);
 CREATE TABLE IF NOT EXISTS knowledge_sources (entry_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY(entry_id,kind,ref));
 CREATE TABLE IF NOT EXISTS knowledge_events (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS knowledge_ws ON knowledge(workspace_id,status);`);
 let mode: "fts5" | "like" = "like";
 if (enableFts) try {
  const existed = db.query("SELECT 1 FROM sqlite_master WHERE name = 'knowledge_fts'").get();
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(title,body,verify,content='knowledge',content_rowid='rowid');
  CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN INSERT INTO knowledge_fts(rowid,title,body,verify) VALUES(new.rowid,new.title,new.body,new.verify); END;
  CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN INSERT INTO knowledge_fts(knowledge_fts,rowid,title,body,verify) VALUES('delete',old.rowid,old.title,old.body,old.verify); END;
  CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN INSERT INTO knowledge_fts(knowledge_fts,rowid,title,body,verify) VALUES('delete',old.rowid,old.title,old.body,old.verify); INSERT INTO knowledge_fts(rowid,title,body,verify) VALUES(new.rowid,new.title,new.body,new.verify); END;`);
  if (!existed) db.run("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')"); mode = "fts5";
 } catch { mode = "like"; }
 const guard = (ctx: KnowledgeContext, human = false) => {
  const w: any = db.query("SELECT * FROM workspaces WHERE id = ?").get(ctx.workspaceId);
  if (!ctx.allowed || !w || w.visibility === "private" || (human && !ctx.human)) throw new Error("knowledge access denied");
  if (!ctx.human && !db.query("SELECT 1 FROM agents WHERE id = ? AND workspace_id = ? AND revoked = 0").get(ctx.actor, ctx.workspaceId)) throw new Error("knowledge access denied");
 };
 const event = (id: string, actor: string, action: string, note = "") => db.query("INSERT INTO knowledge_events(entry_id,actor,action,note,created_at) VALUES(?,?,?,?,?)").run(id, actor, action, note, Date.now());
 const raw = (ctx: KnowledgeContext, id: string): any => {
  guard(ctx); const row: any = db.query("SELECT * FROM knowledge WHERE id = ? AND (workspace_id = ? OR scope = 'global')").get(id, ctx.workspaceId);
  if (!row || (!ctx.human && row.status !== "approved")) throw new Error("no such knowledge entry");
  if (row.project && !db.query("SELECT 1 FROM projects WHERE name = ? AND workspace_id = ?").get(row.project, ctx.workspaceId)) throw new Error("no such knowledge entry");
  return row;
 };
 const sourceFlag = (ctx: KnowledgeContext, source: KnowledgeSource) => {
  if (source.kind === "task") {
   const t: any = db.query("SELECT t.*, p.workspace_id AS ws FROM tasks t JOIN projects p ON p.name = t.project WHERE t.id = ? OR t.key = ?").get(source.ref, source.ref.toUpperCase());
   return { unavailable: !t || t.ws !== ctx.workspaceId, private: !!t && (t.status === "backlog" || !!t.visible_to_agent), label: t?.key ?? source.ref };
  }
  if (source.kind === "message") {
   const m: any = db.query("SELECT * FROM messages WHERE id = ?").get(source.ref);
   const room = ctx.workspaceId === "default" ? "room" : `room:${ctx.workspaceId}`;
   let visible = m?.thread === room;
   if (m?.thread?.startsWith("dm:")) {
    const ids = m.thread.slice(3).split(":").filter((s: string) => s !== "human");
    visible = ctx.human ? ids.every((id: string) => !!db.query("SELECT 1 FROM agents WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId)) : ids.includes(ctx.actor);
   }
   return { unavailable: !visible, private: m?.thread?.startsWith("dm:") ?? false, label: source.ref };
  }
  return { unavailable: false, private: false, label: source.ref };
 };
 const sources = (ctx: KnowledgeContext, id: string) => (db.query("SELECT kind,ref FROM knowledge_sources WHERE entry_id = ?").all(id) as KnowledgeSource[]).map((s) => ({ ...s, ...sourceFlag(ctx, s) })).filter((s) => ctx.human || (!s.unavailable && !s.private));
 const validate = (ctx: KnowledgeContext, input: KnowledgeInput) => {
  guard(ctx); if (!kinds.includes(input.kind)) throw new Error("invalid knowledge kind");
  const title = clean(input.title, "title", P.maxTitle), body = clean(input.body, "body", P.maxBodyBytes, true), verify = clean(input.verify, "verify", P.maxVerify);
  const project = input.project || null;
  if (project && !db.query("SELECT 1 FROM projects WHERE name = ? AND workspace_id = ?").get(project, ctx.workspaceId)) throw new Error("project is outside this workspace");
  if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.length > P.maxSources)) throw new Error("at most five sources");
  const ss = (input.sources ?? []).map((s) => {
   if (!s || !["task", "message", "url"].includes(s.kind)) throw new Error("invalid source kind");
   const ref = clean(s.ref, "source", 1000);
   if (s.kind === "url") { let u; try { u = new URL(ref); } catch { throw new Error("invalid source URL"); } if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("invalid source URL"); }
   const source = { kind: s.kind, ref }; const flag = sourceFlag(ctx, source);
   if (flag.unavailable || (flag.private && s.kind === "task")) throw new Error("private, backlog or unavailable sources cannot be published");
   return source;
  });
  if (new Set(ss.map((s) => s.kind + s.ref)).size !== ss.length) throw new Error("duplicate sources");
  return { kind: input.kind, title, body, verify, project, sources: ss };
 };
 const stale = (r: any) => r.failed_verifications >= 3 || !r.last_verified_at || Date.now() - r.last_verified_at > (r.kind === "how-to" || r.kind === "environment" ? P.environmentStaleDays : P.staleDays) * day;
 const dto = (ctx: KnowledgeContext, r: any) => ({ id: r.id, workspaceId: r.workspace_id, scope: r.scope, project: r.project, kind: r.kind, title: r.title, body: r.body, verify: r.verify, status: r.status, author: r.author_agent_id, approvedBy: r.approved_by, approvedAt: r.approved_at, lastVerifiedAt: r.last_verified_at, verifiedBy: r.verified_by, version: r.version, updatedAt: r.updated_at, stale: stale(r), failedVerifications: r.failed_verifications, correctsEntryId: r.corrects_entry_id, sources: sources(ctx, r.id), events: db.query("SELECT actor,action,note,created_at AS createdAt FROM knowledge_events WHERE entry_id = ? ORDER BY id").all(r.id), framing: KNOWLEDGE_FRAME });
 const create = (ctx: KnowledgeContext, input: KnowledgeInput, corrects?: string) => {
  const v = validate(ctx, input), id = crypto.randomUUID(), at = Date.now();
  db.transaction(() => {
   db.query("INSERT INTO knowledge(id,workspace_id,project,scope,kind,title,body,verify,status,author_agent_id,approved_by,approved_at,created_at,updated_at,corrects_entry_id) VALUES(?,?,?,'workspace',?,?,?,?,?,?,?,?,?,?,?)").run(id, ctx.workspaceId, v.project, v.kind, v.title, v.body, v.verify, ctx.human ? "approved" : "proposed", ctx.actor, ctx.human ? ctx.actor : null, ctx.human ? at : null, at, at, corrects ?? null);
   for (const s of v.sources) db.query("INSERT INTO knowledge_sources(entry_id,kind,ref) VALUES(?,?,?)").run(id, s.kind, s.ref);
   event(id, ctx.actor, ctx.human ? "create-approved" : "propose");
  })();
  return { id, status: ctx.human ? "approved" : "proposed" };
 };
 const search = (ctx: KnowledgeContext, options: { query?: string; kind?: string; project?: string; limit?: number } = {}) => {
  guard(ctx); if (options.project && !db.query("SELECT 1 FROM projects WHERE name = ? AND workspace_id = ?").get(options.project, ctx.workspaceId)) throw new Error("project is outside this workspace");
  const q = (options.query ?? "").slice(0, 200), terms = q.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const fts = mode === "fts5" && terms.length > 0;
  let sql = `SELECT k.*${fts ? ", bm25(knowledge_fts, 4.0, 1.0, 2.0) AS rank" : ""} FROM knowledge k ${fts ? "JOIN knowledge_fts ON knowledge_fts.rowid = k.rowid" : ""} WHERE k.status = 'approved' AND (k.workspace_id = ? OR k.scope = 'global') AND (k.project IS NULL OR k.project IN (SELECT name FROM projects WHERE workspace_id = ?))`;
  const args: any[] = [ctx.workspaceId, ctx.workspaceId];
  if (options.kind) { sql += " AND k.kind = ?"; args.push(options.kind); }
  if (options.project) { sql += " AND k.project = ?"; args.push(options.project); }
  if (fts) { sql += " AND knowledge_fts MATCH ?"; args.push(terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(" AND ")); }
  else if (q) { sql += " AND (k.title LIKE ? OR k.body LIKE ? OR k.verify LIKE ?)"; args.push(...Array(3).fill("%" + q + "%")); }
  sql += " ORDER BY CASE WHEN k.failed_verifications >= 3 OR k.last_verified_at IS NULL OR k.last_verified_at < ? - CASE WHEN k.kind IN ('environment','how-to') THEN ? ELSE ? END THEN 1 ELSE 0 END, " + (fts ? "rank, " : "") + "k.last_verified_at DESC, k.created_at DESC LIMIT ?";
  args.push(Date.now(), P.environmentStaleDays * day, P.staleDays * day, Math.max(1, Math.min(P.searchLimit, options.limit ?? 10)));
  const rows: any[] = db.query(sql).all(...args);
  return { searchMode: mode, ...(mode === "like" ? { warning: "FTS5 unavailable; using LIKE search" } : {}), framing: KNOWLEDGE_FRAME, entries: rows.map((r) => ({ id: r.id, title: r.title, kind: r.kind, snippet: r.body.slice(0, 180), verify: r.verify, lastVerifiedAt: r.last_verified_at, stale: stale(r), scope: r.scope })) };
 };
 const index = (ctx: KnowledgeContext) => {
  guard(ctx); const rows: any[] = db.query("SELECT * FROM knowledge WHERE status = 'approved' AND (workspace_id = ? OR scope = 'global') AND (project IS NULL OR project IN (SELECT name FROM projects WHERE workspace_id = ?)) ORDER BY CASE kind WHEN 'gotcha' THEN 0 WHEN 'environment' THEN 1 WHEN 'how-to' THEN 2 ELSE 3 END, last_verified_at DESC, id").all(ctx.workspaceId, ctx.workspaceId);
  const version = createHash("sha256").update(JSON.stringify(rows.map((r) => [r.id, r.updated_at, r.version, stale(r)]))).digest("hex");
  return { version, ...knowledgeBlock(rows.map((r) => ({ id: r.id, title: r.title, kind: r.kind, stale: stale(r), scope: r.scope, lastVerifiedAt: r.last_verified_at })), rows.length) };
 };
 const change = (ctx: KnowledgeContext, id: string, action: string, patch: any = {}) => {
  guard(ctx, true); const r = raw(ctx, id);
  const editing = ctx.human && r.scope === "global" ? { ...ctx, workspaceId: r.workspace_id } : ctx;
  if (patch.ifVersion !== undefined && patch.ifVersion !== r.version) throw new Error("knowledge changed; reload before approving or editing");
  return db.transaction(() => {
   if (action === "edit") {
    const v = validate(editing, { kind: patch.kind ?? r.kind, title: patch.title ?? r.title, body: patch.body ?? r.body, verify: patch.verify ?? r.verify, project: patch.project === undefined ? r.project : patch.project, sources: patch.sources ?? (sources(ctx, id).map(({ kind, ref }) => ({ kind, ref }))) });
    db.query("UPDATE knowledge SET kind=?,title=?,body=?,verify=?,project=? WHERE id=?").run(v.kind, v.title, v.body, v.verify, v.project, id);
    db.query("DELETE FROM knowledge_sources WHERE entry_id=?").run(id); for (const s of v.sources) db.query("INSERT INTO knowledge_sources(entry_id,kind,ref) VALUES(?,?,?)").run(id, s.kind, s.ref);
   } else if (action === "approve") {
    if (r.status !== "proposed") throw new Error("only proposed entries can be approved");
    validate(editing, { ...r, sources: sources(ctx, id).map(({ kind, ref }) => ({ kind, ref })) });
    db.query("UPDATE knowledge SET status='approved',approved_by=?,approved_at=? WHERE id=?").run(ctx.actor, Date.now(), id);
   } else if (action === "archive") db.query("UPDATE knowledge SET status='archived' WHERE id=?").run(id);
   else if (action === "promote") {
    if (r.status !== "approved" || r.scope !== "workspace") throw new Error("approve a workspace entry before promotion");
    validate(editing, { ...r, sources: sources(ctx, id).map(({ kind, ref }) => ({ kind, ref })) });
    const copy: any = create(ctx, { ...r, project: null, sources: sources(ctx, id).map(({ kind, ref }) => ({ kind, ref })) });
    db.query("UPDATE knowledge SET scope='global',author_agent_id=? WHERE id=?").run(r.author_agent_id, copy.id); event(copy.id, ctx.actor, "promote", `copy of ${id}`); event(id, ctx.actor, "promote", `copied to ${copy.id}`);
    db.query("UPDATE knowledge SET version=version+1,updated_at=? WHERE id=?").run(Date.now(), id); return dto(ctx, raw(ctx, copy.id));
   } else throw new Error("invalid knowledge action");
   db.query("UPDATE knowledge SET version=version+1,updated_at=? WHERE id=?").run(Date.now(), id); event(id, ctx.actor, action);
   return dto(ctx, raw(ctx, id));
  })();
 };
 return {
  knowledgeSearchMode: mode, knowledgeCreate: create, knowledgeSearch: search, knowledgeIndex: index,
  knowledgeGet(ctx: KnowledgeContext, id: string) { return dto(ctx, raw(ctx, id)); },
  knowledgeChange: change,
  knowledgeList(ctx: KnowledgeContext, filters: any = {}) {
   guard(ctx, true); let rows: any[] = db.query("SELECT * FROM knowledge WHERE workspace_id = ? OR scope = 'global' ORDER BY updated_at DESC").all(ctx.workspaceId);
   rows = rows.filter((r) => (!filters.status || r.status === filters.status) && (!filters.kind || r.kind === filters.kind) && (!filters.project || r.project === filters.project) && (!filters.q || (r.title + " " + r.body).toLowerCase().includes(String(filters.q).toLowerCase())));
   return { entries: rows.slice(0, 200).map((r) => dto(ctx, r)), framing: KNOWLEDGE_FRAME };
  },
  knowledgeMeta() { return (db.query("SELECT id FROM workspaces WHERE visibility != 'private'").all() as { id: string }[]).map((w) => { const rows: any[] = db.query("SELECT id,status,version FROM knowledge WHERE workspace_id = ? OR scope='global' ORDER BY id").all(w.id); return { workspaceId: w.id, proposed: rows.filter((r) => r.status === "proposed").length, version: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }; }); },
  knowledgeVerify(ctx: KnowledgeContext, id: string, ok: boolean, note: string) {
   guard(ctx); if (typeof ok !== "boolean") throw new Error("verification result required"); const r = raw(ctx, id); const checked = clean(note, "verification note", 1000, true);
   return db.transaction(() => {
    let correction: any = null;
    if (!ok) correction = create({ ...ctx, human: false }, { kind: r.kind, title: ("Correction: " + r.title).slice(0, P.maxTitle), body: `Verification failed: ${checked}`, verify: r.verify, project: r.project, sources: [] }, id);
    db.query("UPDATE knowledge SET last_verified_at=CASE WHEN ? THEN ? ELSE last_verified_at END,verified_by=CASE WHEN ? THEN ? ELSE verified_by END,failed_verifications=CASE WHEN ? THEN 0 ELSE failed_verifications+1 END,version=version+1,updated_at=? WHERE id=?").run(ok ? 1 : 0, Date.now(), ok ? 1 : 0, ctx.actor, ok ? 1 : 0, Date.now(), id);
    event(id, ctx.actor, ok ? "verify" : "verify-failed", checked); return { ok, correction, entry: dto(ctx, raw(ctx, id)) };
   })();
  },
 };
}
