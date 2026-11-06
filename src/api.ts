import type { Hono } from "hono";
import { diskState, type DiskState } from "./disk";
import { randomBytes } from "node:crypto";
import { tokenMatches } from "./auth";
import { streamTickets, uiCsp, type SecurityOptions } from "./security";
import { streamSSE } from "hono/streaming";
import { installInstructions, validName } from "../cli/fleet";
import { hubOrigin } from "./public-url";
import { listRepos, integrate, gitRun, ensureRepo } from "./git";
import { RESERVED_NAMES, workspaceOfRoom, type Hub } from "./hub";
import { deviceRequestsView, devicesView } from "./devices";
import type { Store } from "./store";

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function mountApi(app: Hono, hub: Hub, store: Store, humanToken: string, signedUrl: (id: string) => string = () => "", dataDir = "", security: SecurityOptions = {}, publicUrl = "", storage:()=>DiskState=()=>diskState(dataDir,store.dbPath)): void {
  const tickets = streamTickets(security.now);
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : security.allowQueryToken ? (c.req.query("token") ?? "") : "";
    const human = tokenMatches(given, humanToken);
    const ticket = c.req.path === "/api/events" && c.req.method === "GET" ? c.req.query("ticket") : undefined;
    if (!human && !(ticket && tickets.consume(ticket))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  // The harness table is shared with the browser, so the Devices page offers exactly what the CLI and hub accept.
  app.get("/harnesses.js", async (c) =>
    c.body(new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(new URL("../shared/harnesses.ts", import.meta.url)).text()), 200, { "content-type": "text/javascript; charset=utf-8" }),
  );
  app.get("/mention.js", async (c) =>
    c.body(await Bun.file(new URL("../ui/mention.js", import.meta.url)).text(), 200, { "content-type": "text/javascript; charset=utf-8" }),
  );
  app.get("/markdown.js", async (c) =>
    c.body(await Bun.file(new URL("../ui/markdown.js", import.meta.url)).text(), 200, { "content-type": "text/javascript; charset=utf-8" }),
  );
  // The keyboard table and parser are shared with tests, so the page loads them as a module rather than inlining them.
  app.get("/keys.js", async (c) =>
    c.body(await Bun.file(new URL("../ui/keys.js", import.meta.url)).text(), 200, { "content-type": "text/javascript; charset=utf-8" }),
  );
  // The palette ranking, command parser and keymap storage are shared with tests the same way.
  app.get("/palette.js", async (c) =>
    c.body(await Bun.file(new URL("../ui/palette.js", import.meta.url)).text(), 200, { "content-type": "text/javascript; charset=utf-8" }),
  );
  // Onboarding tour steps and checklist state shared with tests.
  app.get("/onboarding.js", async (c) =>
    c.body(await Bun.file(new URL("../ui/onboarding.js", import.meta.url)).text(), 200, { "content-type": "text/javascript; charset=utf-8" }),
  );

  const knowledgeResponse = async (c: any, action: string) => {
    try {
      const body = ["GET", "HEAD"].includes(c.req.method) ? c.req.query() : await c.req.json().catch(() => ({}));
      if (!body) return c.json({ error: "knowledge payload required" }, 400);
      const workspace = c.req.query("workspace") ?? body.workspace ?? "default";
      if (typeof workspace !== "string" || !store.getWorkspace(workspace)) return c.json({ error: "no such workspace" }, 404);
      return c.json(hub.humanKnowledge(workspace, action, c.req.param("id"), body));
    } catch (e) { const error = (e as Error).message; return c.json({ error }, error.includes("no such") ? 404 : error.includes("changed; reload") ? 409 : 400); }
  };
  app.get("/api/knowledge", (c) => knowledgeResponse(c, "list"));
  app.post("/api/knowledge", (c) => knowledgeResponse(c, "create"));
  app.get("/api/knowledge/:id", (c) => knowledgeResponse(c, "get"));
  app.patch("/api/knowledge/:id", (c) => knowledgeResponse(c, "edit"));
  for (const action of ["approve", "archive", "promote"]) app.post(`/api/knowledge/:id/${action}`, (c) => knowledgeResponse(c, action));

  app.get("/api/schedules",c=>c.json(hub.schedulesView()));
  app.post("/api/schedules",async c=>{try{return c.json(hub.createSchedule(await c.req.json()));}catch(e){return c.json({error:(e as Error).message},400);}});
  app.patch("/api/schedules/:id",async c=>{try{return c.json(hub.updateSchedule(c.req.param("id"),await c.req.json()));}catch(e){return c.json({error:(e as Error).message},400);}});
  app.delete("/api/schedules/:id",c=>{try{return c.json(hub.deleteSchedule(c.req.param("id")));}catch(e){return c.json({error:(e as Error).message},404);}});

  app.get("/api/repos", async (c) => c.json(await listRepos(dataDir,store)));
  app.get("/api/storage", (c)=>c.json(storage()));
  app.post("/api/repos/:project/integrate",async c=>{try{const b=await c.req.json();const r=await integrate(dataDir,store,c.req.param("project"),b.branch,b.expectedMain,"human");store.addMessage({thread:"room",from:"human",text:`Integrated ${r.project} ${r.branch}: ${r.fromSha.slice(0,8)} → ${r.toSha.slice(0,8)}`});hub.notify();return c.json(r);}catch(e){return c.json({error:(e as Error).message},409);}});
  app.delete("/api/repos/:project/branches",async c=>{try{const b=await c.req.json();if(!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(c.req.param("project")))throw Error("bad project name");if(typeof b.branch!=="string"||!/^[-a-z0-9]+\/[-a-zA-Z0-9._/]+$/.test(b.branch)||b.branch.includes("..")||!b.expectedSha)throw Error("task branch and expectedSha required");await gitRun(`${dataDir}/repos/${c.req.param("project")}.git`,"update-ref","-d",`refs/heads/${b.branch}`,b.expectedSha);hub.notify();return c.json({ok:true});}catch(e){return c.json({error:(e as Error).message},409);}});

  app.get("/", async (c) => {
    const nonce = randomBytes(18).toString("base64");
    c.header("Content-Security-Policy", uiCsp(nonce));
    c.header("Cache-Control", "no-store");
    const html = await Bun.file(new URL("../ui/index.html", import.meta.url)).text();
    return c.html(html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`));
  });

  // Who each message is for and how far it has got, so the human can see which agent has actually picked it up.
  const withDelivery = (m: any) => ({ ...m, delivery: hub.deliveryFor(m) });

  app.get("/api/state", (c) => {
    // Files that came with a message, listed on it. The signed link works without the token, like the task artifacts.
    const arts = store.artifactsFor().map((a) => ({ ...a, url: signedUrl(a.id) }));
    const onMsg = new Map<number, any[]>();
    for (const a of arts) if (a.messageId != null) (onMsg.get(a.messageId) ?? onMsg.set(a.messageId, []).get(a.messageId)!).push({ id: a.id, kind: a.kind, name: a.name, size: a.size, mime: a.mime, url: a.url });
    const withFiles = (m: any) => ({ ...m, attachments: onMsg.get(m.id) ?? [] });
    return c.json({
      schedules: hub.schedulesView(),
      knowledgeMeta: store.knowledgeMeta(),
      attachmentLimits: { maxBytes: hub.humanAttachmentMaxBytes, maxCount: hub.humanAttachmentMaxCount },
      roomReplies: store.listWorkspaces().flatMap((w) => { const reply = hub.roomReplyWindow(w.id); return reply ? [reply] : []; }),
      agents: store.listAgents().map((a) => ({ ...a, external: hub.isExternal(a), grants: store.projectsOf(a.id), activity: hub.activityOf(a.id) })),
      deletedTasks: store.deletedTasks(),
      tasks: store.listTasks().map((t) => ({ ...t, lease: hub.leaseOf(t), workspaceId: store.projectWorkspace(t.project) ?? "default" })),
      requests: store.openRequests(),
      retired: store.listRetiredAgents(),
      workspaces: store.listWorkspaces(),
      devices: devicesView(store),
      deviceRequests: deviceRequestsView(store),
      projects: store.listProjects(),
      room: store.roomMessages().slice(-300).map((m) => ({ ...withFiles(withDelivery(m)), workspace: workspaceOfRoom(m.thread) })),
      touches: store.touchesFor().slice(-200),
      dms: store.dmsWithHuman().slice(-200).map((m) => withFiles(withDelivery(m))),
      agentDms: store.dmsBetweenAgents().slice(-300).map(withFiles),
      taskEvents: store.taskEvents().slice(-1000),
      evidence: store.allEvidence(),
      artifacts: arts,
    });
  });

  app.get("/api/requests/:id", (c) => {
    const r = store.getRequest(c.req.param("id"));
    if (!r) return c.json({ error: "no such request" }, 404);
    return c.json(r);
  });

  app.post("/api/requests/:id/answer", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    if (!str(body.answer)) return c.json({ error: "answer required" }, 400);
    try {
      hub.humanAnswer(c.req.param("id"), body.answer);
    } catch {
      return c.json({ error: "no open request" }, 409);
    }
    return c.json({ ok: true });
  });

  app.post("/api/room", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    if (body.text != null && typeof body.text !== "string") return c.json({ error: "text must be a string" }, 400);
    if (body.attachments != null && (!Array.isArray(body.attachments) || body.attachments.some((id: unknown) => typeof id !== "string"))) return c.json({ error: "attachments must be an array of upload ids" }, 400);
    try { return c.json(hub.humanSay(body.text ?? "", str(body.workspace) ? body.workspace : undefined, body.attachments ?? [])); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  app.post("/api/dm/:agent", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    if (body.text != null && typeof body.text !== "string") return c.json({ error: "text must be a string" }, 400);
    if (body.attachments != null && (!Array.isArray(body.attachments) || body.attachments.some((id: unknown) => typeof id !== "string"))) return c.json({ error: "attachments must be an array of upload ids" }, 400);
    try {
      return c.json(hub.humanDm(c.req.param("agent"), body.text ?? "", body.attachments ?? [], typeof body.requestId === "string" ? body.requestId : undefined));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Create an agent. The token is returned once; only its hash is stored.
  // Creates an agent. The token is returned once; only its hash is stored.
  const makeAgent = (body: any): { status: 200 | 400 | 409; json: Record<string, unknown> } => {
    const name = typeof body?.name === "string" ? body.name : "";
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return { status: 400, json: { error: "name must be 1-40 lowercase letters, digits or dashes" } };
    if (RESERVED_NAMES.includes(name)) return { status: 400, json: { error: `"${name}" is reserved (@${name} addresses everyone)` } };
    if (store.listAgents().some((a) => a.name === name)) return { status: 409, json: { error: `an agent named ${name} already exists` } };
    const owner = typeof body.owner === "string" && body.owner ? body.owner : hub.hubOwner || "owner";
    const device = typeof body.device === "string" && body.device ? body.device : "unknown";
    const skills = Array.isArray(body.skills) ? body.skills.filter((x: unknown) => typeof x === "string") : [];
    let ws;
    try { ws = str(body.workspace) ? hub.resolveWorkspace(body.workspace) : store.defaultWorkspace(); } catch (e) { return { status: 400, json: { error: (e as Error).message } }; }
    const { token } = store.addAgent({ name, owner, device, skills, workspaceId: ws.id });
    hub.notify();
    return { status: 200, json: { name, owner, device, token, workspace: ws.name } };
  };

  app.post("/api/agents", async (c) => {
    const r = makeAgent(await c.req.json().catch(() => ({})));
    return c.json(r.json, r.status);
  });

  // For a tool the fleet has no adapter for: create its agent and hand back the instructions the tool follows to connect itself.
  app.post("/api/agents/prompt", async (c) => {
    const r = makeAgent({ ...(await c.req.json().catch(() => ({}))), device: "your own tool" });
    if (r.status !== 200) return c.json(r.json, r.status);
    const origin = hubOrigin(c.req.url, publicUrl);
    return c.json({ name: r.json.name, workspace: r.json.workspace, prompt: installInstructions({ hubUrl: origin, token: r.json.token as string, name: r.json.name as string }) });
  });

  // Tokens are shown once and only their hash is kept, so a lost one cannot be read back: issue a new one instead.
  app.post("/api/agents/:name/stop", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || (body.text !== undefined && typeof body.text !== "string") || (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > hub.humanAttachmentMaxCount || body.attachments.some((id: unknown) => typeof id !== "string")))) return c.json({ error: "optional text and attachment ids required" }, 400);
    try { return c.json(hub.stopAgent(c.req.param("name"), body.text ?? "", body.attachments ?? [])); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  app.post("/api/agents/:name/token", (c) => {
    const name = c.req.param("name");
    const done = store.rotateAgentToken(name);
    if (!done) return c.json({ error: "no active agent with that name" }, 404);
    const agent = store.agentById(done.id)!;
    hub.notify();
    // The join prompt is for an outside agent being handed a new token; rotating keeps its expiry, so an invitation
    // that has already lapsed stays lapsed instead of becoming permanent by accident.
    const prompt = installInstructions({ hubUrl: hubOrigin(c.req.url, publicUrl), token: done.token, name });
    return c.json({ name, owner: agent.owner, device: agent.device, expiresAt: agent.expiresAt, token: done.token, prompt });
  });

  // ---- outside agents: invited and managed from the Access page, never shown the main room ----
  app.post("/api/external-agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!validName(name)) return c.json({ error: "the agent name must be 1-40 lowercase letters, digits or dashes" }, 400);
    if (RESERVED_NAMES.includes(name)) return c.json({ error: `"${name}" is reserved (@${name} addresses everyone)` }, 400);
    if (store.listAgents().some((a) => a.name === name)) return c.json({ error: `an agent named ${name} already exists` }, 409);
    const owner = typeof body.owner === "string" ? body.owner.trim().slice(0, 80) : "";
    if (!owner) return c.json({ error: "say whose agent it is: the owner label is required" }, 400);
    // An agent owned by the hub owner is a team agent and would get the whole workspace; invites are only for other people.
    if (!hub.hubOwner) return c.json({ error: "this hub has no owner set, so it cannot tell team agents from outside ones" }, 400);
    if (owner === hub.hubOwner) return c.json({ error: `${owner} runs this hub: their agents are team agents, added on the Devices page` }, 400);
    const days = body.expiresInDays == null ? null : Number(body.expiresInDays);
    if (days !== null && !(Number.isFinite(days) && days > 0 && days <= 365)) return c.json({ error: "expiry must be a number of days between 1 and 365, or left empty for never" }, 400);
    const wanted: unknown[] = Array.isArray(body.projects) ? body.projects : [];
    const projects: string[] = [...new Set(wanted.filter((p): p is string => typeof p === "string" && !!p.trim()))];
    const known = new Set(store.listProjects().map((p) => p.name));
    const missing = projects.find((p) => !known.has(p));
    if (missing) return c.json({ error: `no project named ${missing}: create it first, or invite without it and grant it later` }, 400);
    const expiresAt = days === null ? null : Date.now() + Math.round(days * 86400_000);
    const { id, token } = store.addAgent({ name, owner, device: "outside", skills: [], expiresAt });
    for (const p of projects) store.grantProject(id, p);
    hub.notify();
    return c.json({ name, owner, projects, expiresAt, token, prompt: installInstructions({ hubUrl: hubOrigin(c.req.url, publicUrl), token, name }) });
  });

  app.delete("/api/external-agents/:name", (c) => {
    const agent = store.listAgents().find((a) => a.name === c.req.param("name"));
    if (!agent) return c.json({ error: "no active agent with that name" }, 404);
    if (!hub.isExternal(agent)) return c.json({ error: `${agent.name} is a team agent: remove it on the Team page` }, 400);
    return c.json({ ok: true, ...hub.removeAgent(agent.name) });
  });

  app.post("/api/workspaces", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    try { return c.json(hub.createWorkspace(String(body?.name ?? ""))); }
    catch (e) { const m = (e as Error).message; return c.json({ error: m }, /already exists/.test(m) ? 409 : 400); }
  });

  app.post("/api/workspaces/:id/rename", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    try { return c.json(hub.renameWorkspace(c.req.param("id"), String(body?.name ?? ""))); }
    catch (e) { const m = (e as Error).message; return c.json({ error: m }, /already exists/.test(m) ? 409 : 400); }
  });

  app.post("/api/agents/:name/workspace", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    try { return c.json(hub.moveAgent(c.req.param("name"), String(body?.workspace ?? ""))); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  app.post("/api/agents/:name/role", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    const a = store.listAgents().find((x) => x.name === c.req.param("name"));
    if (!a) return c.json({ error: "no active agent with that name" }, 404);
    try { hub.setRole(a, String(body?.role ?? "")); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  app.post("/api/agents/:name/instructions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    const a = store.listAgents().find((x) => x.name === c.req.param("name"));
    if (!a) return c.json({ error: "no active agent with that name" }, 404);
    try { hub.setInstructions(a, String(body?.instructions ?? "")); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  app.delete("/api/agents/:name", (c) => {
    const done = hub.removeAgent(c.req.param("name"));
    if (!done) return c.json({ error: "no active agent with that name" }, 404);
    return c.json({ ok: true, ...done });
  });

  app.post("/api/agents/:name/grants", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    if (!str(body?.project)) return c.json({ error: "project is required" }, 400);
    try { hub.grant(c.req.param("name"), body.project); hub.notify(); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  app.delete("/api/agents/:name/grants/:project", (c) => {
    try { hub.revokeGrant(c.req.param("name"), decodeURIComponent(c.req.param("project"))); hub.notify(); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  app.post("/api/requests/:id/decide", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    if (typeof body?.approve !== "boolean") return c.json({ error: "approve (true or false) is required" }, 400);
    try {
      hub.decideHandoff(c.req.param("id"), body.approve);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/api/tasks/:id/status", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !["open", "claimed", "in_progress", "blocked", "done", "backlog"].includes(body.status) || (body.note !== undefined && typeof body.note !== "string")) return c.json({ error: "valid status and optional text note required" }, 400);
    try { return c.json(hub.humanStatus(c.req.param("id"), body.status, body.note)); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });

  app.delete("/api/tasks/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.confirm !== "string") return c.json({ error: "confirm the exact task key" }, 400);
    try { return c.json(hub.humanDeleteTask(c.req.param("id"), body.confirm)); }
    catch (e) {
      const message = (e as Error).message;
      return c.json({ error: message }, message.includes("subtasks") ? 409 : message.includes("no such") ? 404 : 400);
    }
  });

  app.post("/api/tasks/:id/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    if (typeof body?.required !== "boolean") return c.json({ error: "required must be true or false" }, 400);
    try {
      return c.json(hub.setPreviewRequired(c.req.param("id"), body.required));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/api/tasks/:id/request-outcome", (c) => {
    try {
      return c.json(hub.requestOutcome(c.req.param("id")));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/api/tasks/:id/release", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) ?? {};
      if (body?.to !== undefined && typeof body.to !== "string") return c.json({ error: "to must be an agent name" }, 400);
      return c.json(hub.humanRelease(c.req.param("id"), body?.to || undefined));
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, /no agent|unknown agent/i.test(msg) ? 400 : 404);
    }
  });

  app.post("/api/tasks", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    if (!str(body.title) || !str(body.project)) return c.json({ error: "title and project required" }, 400);
    if (body.needsPreview !== undefined && typeof body.needsPreview !== "boolean") return c.json({ error: "needsPreview must be true or false" }, 400);
    if (body.backlog !== undefined && typeof body.backlog !== "boolean") return c.json({ error: "backlog must be true or false" }, 400);
    for (const k of ["description", "acceptance"]) if (body[k] !== undefined && typeof body[k] !== "string") return c.json({ error: `${k} must be text` }, 400);
    try {
      return c.json(hub.humanCreateTask({ title: body.title, project: body.project, assignee: str(body.assignee) ? body.assignee : undefined, description: body.description, acceptance: body.acceptance, needsPreview: body.needsPreview, backlog: body.backlog, workspaceId: str(body.workspace) ? hub.resolveWorkspace(body.workspace).id : undefined }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/api/events/ticket", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ticket: tickets.mint(), expiresIn: 60 });
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const off = hub.onChange(() => {
        if (open) void stream.writeSSE({ event: "change", data: "1" });
      });
      stream.onAbort(() => {
        open = false;
        off();
      });
      await stream.writeSSE({ event: "hello", data: "1" });
      while (open) {
        await stream.sleep(15000);
        if (open) await stream.writeSSE({ event: "ping", data: "1" });
      }
    }),
  );
}
