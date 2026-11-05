import { repoStatus } from "./git";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { extraArgsFor, validName } from "../cli/fleet";
import { USAGE_HARNESSES, type HarnessUsage, type Usage, type UsageTotals, type UsageWindow } from "../cli/usage";
import { harnessInfo, normalizeHarnessName, validateSessionId } from "../shared/harnesses";
import { underRoots } from "../shared/paths";
import { RESERVED_NAMES, type Hub } from "./hub";
import type { Device, DeviceRequest, Store } from "./store";

const ONLINE_MS = 45_000;
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const cap = <T,>(v: unknown, n: number): T[] => (Array.isArray(v) ? (v.slice(0, n) as T[]) : []);

/** What the UI may see of a device: never its token. */
export function devicesView(store: Store) {
  return store.listDevices().map((d) => ({
    id: d.id, name: d.name, online: Date.now() - d.lastSeen < ONLINE_MS, lastSeen: d.lastSeen,
    hostname: d.info.hostname ?? null, harnesses: d.info.harnesses ?? [], roots: d.info.roots ?? [], models: d.info.models ?? {}, modelInfo: d.info.modelInfo ?? {}, usage: d.info.usage ?? {}, sessions: d.info.sessions ?? [],
    reported: !!d.info.harnesses, launched: store.agentsOfDevice(d.id).length, agentIds: store.agentsOfDevice(d.id).map((a) => a.id),
  }));
}

const USAGE_MAX_HARNESSES = 10, USAGE_MAX_WINDOWS = 8;
const USAGE_WINDOW_KINDS = new Set(["5h", "session", "weekly", "other"]);
/** A number a device sent, however it sent it: "12" is 12, and NaN, Infinity or "soon" is nothing at all. */
const finiteNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The usage from a report, as much of it as the UI can trust: capped, coerced, unknown keys dropped, unusable harnesses left out. */
export function sanitiseUsage(raw: unknown): Usage {
  const out: Usage = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= USAGE_MAX_HARNESSES) break;
    // Only the contract's ids: "prime" is reported as "prime-agent", and a device cannot invent a harness.
    if (!USAGE_HARNESSES.includes(id) || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const source = typeof e.source === "string" ? e.source.slice(0, 80) : "";
    const observedAt = finiteNum(e.observedAt);
    if (!source || observedAt === null || observedAt < 0) continue;          // nothing the UI could show beside the numbers
    const windows: UsageWindow[] = [];
    for (const w of Array.isArray(e.windows) ? e.windows.slice(0, USAGE_MAX_WINDOWS) : []) {
      if (!w || typeof w !== "object") continue;
      const label = typeof (w as any).label === "string" ? (w as any).label.slice(0, 80) : "";
      const used = finiteNum((w as any).usedFraction);
      if (!label || used === null) continue;
      const resets = finiteNum((w as any).resetsAt);
      windows.push({ label, window: USAGE_WINDOW_KINDS.has((w as any).window) ? (w as any).window : "other", usedFraction: Math.max(0, Math.min(1, used)), resetsAt: resets });
    }
    const entry: HarnessUsage = { source, observedAt, windows };
    const t = (e.totals && typeof e.totals === "object" && !Array.isArray(e.totals) ? e.totals : null) as Record<string, unknown> | null;
    if (t) {
      const totals: UsageTotals = {};
      for (const k of ["tokens", "sessions", "prompts"] as const) { const n = finiteNum(t[k]); if (n !== null && n >= 0) totals[k] = n; }
      if (typeof t.note === "string" && t.note) totals.note = t.note.slice(0, 200);
      if (Object.keys(totals).length) entry.totals = totals;
    }
    if (typeof e.error === "string" && e.error) entry.error = e.error.slice(0, 200);
    out[id] = entry;
  }
  return out;
}

/** What the UI may see of a request: never the agent token inside it. */
export function deviceRequestsView(store: Store) {
  const active = new Set(store.listAgents().map((a) => a.id));
  return store.listDeviceRequests().map((r) => {
    const { token: _token, ...payload } = r.payload;
    // A request whose agent has since been removed is history, not something running.
    return { id: r.id, deviceId: r.deviceId, agentId: r.agentId, kind: r.kind, status: r.status, message: r.message, needsConfirmation: r.needsConfirmation, createdAt: r.createdAt, updatedAt: r.updatedAt, agentRemoved: !!r.agentId && !active.has(r.agentId), payload };
  });
}

/** Machines that can be asked to start agents. The human side lives under /api (already authenticated), the device side under /device (its own token). */
export function mountDevices(app: Hono, hub: Hub, store: Store): void {
  // ---- the human ----
  app.post("/api/devices", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 60) return c.json({ error: "a device needs a name of 1 to 60 characters" }, 400);
    const { id, token } = store.addDevice(name);
    hub.notify();
    return c.json({ id, name, token });                 // shown once; only its hash is kept
  });

  app.delete("/api/devices/:id", (c) => {
    const id = c.req.param("id");
    if (!store.getDevice(id)) return c.json({ error: "no such device" }, 404);
    // The device's token goes first, so nothing more can be asked of it; then every agent it started loses its token too.
    const agents = store.agentsOfDevice(id);
    store.revokeDevice(id);
    for (const a of agents) store.revokeAgent(a.name);
    for (const r of store.openDeviceRequests(id)) store.setDeviceRequest(r.id, "failed", "the device was removed");
    hub.notify();
    return c.json({ ok: true, revokedAgents: agents.map((a) => a.name) });
  });

  app.post("/api/devices/:id/launch", async (c) => {
    const device = store.getDevice(c.req.param("id"));
    if (!device) return c.json({ error: "no such device" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const bad = (error: string, status: 400 | 409 = 400) => c.json({ error }, status);

    if (!device.info.harnesses) return bad("this device has not reported in yet: start `fleet device run` on it and wait a few seconds", 409);
    // Continuing as an agent that already exists keeps its identity, workspace and tasks; only its token and device change.
    const continuing = str(body.asAgent) ? store.listAgents().find((a) => a.name === body.asAgent) : undefined;
    if (str(body.asAgent) && !continuing) return bad(`no agent named ${body.asAgent}`);
    if (continuing && hub.isExternal(continuing)) return bad(`${continuing.name} is an outside agent: only your team's agents can be continued from here`);
    const name = continuing ? continuing.name : str(body.name) ? body.name : "";
    if (!continuing && RESERVED_NAMES.includes(name)) return bad(`"${name}" is reserved (@${name} addresses everyone)`);
    if (!continuing && !validName(name)) return bad("the agent name must be 1-40 lowercase letters, digits or dashes");
    const harness = normalizeHarnessName(body.harness);
    if (!harness) return bad("unknown harness");
    if (!device.info.harnesses.some((h) => h.id === harness)) return bad(`${harnessInfo(harness).label} is not installed on ${device.name} (it has: ${device.info.harnesses.map((h) => h.id).join(", ") || "nothing"})`);
    const dir = str(body.dir) ? body.dir : "";
    if (!dir.startsWith("/")) return bad("the folder must be an absolute path");
    if (!underRoots(dir, device.info.roots ?? [])) return bad(`${dir} is outside the folders ${device.name} allows. Allow it on the device first: fleet device allow <folder>`);
    const permissions = (str(body.permissions) ? body.permissions : "safe") as "safe" | "edits" | "open";
    try { extraArgsFor(harness, permissions); } catch (e) { return bad((e as Error).message); }
    const info = harnessInfo(harness);
    const model = str(body.model) ? body.model : undefined;
    if (info.model === "required" && !model) return bad(`${info.label} needs a model, for example ${info.modelExample}`);
    // A custom command that interpolates {model} must get one; an empty substitution would start the tool with a broken argument.
    if (harness === "custom" && [body.runCmd, body.resumeCmd].some((t) => typeof t === "string" && t.includes("{model}")) && !model)
      return bad("the custom command uses {model}, so a model is required: pass one, or remove {model} from the command");
    if (harness === "custom" && !str(body.runCmd)) return bad("a custom tool needs a run command (the command that runs one turn, with {prompt} and {session})");
    const session = str(body.session) ? body.session : undefined;
    if (session) { const why = validateSessionId(harness, session); if (why) return bad(`cannot adopt session ${session}: ${why}`); }
    let workspaceId = continuing ? continuing.workspaceId : store.defaultWorkspace().id;
    if (!continuing && str(body.workspace)) { try { workspaceId = hub.resolveWorkspace(body.workspace).id; } catch (e) { return bad((e as Error).message); } }
    if (!continuing && store.listAgents().some((a) => a.name === name)) return bad(`an agent named ${name} already exists`, 409);
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : undefined;
    if (instructions && instructions.length > 4000) return bad("instructions are at most 4000 characters");

    let canonical: {project:string;base:string;branch:string}|undefined;
    if(body.project!==undefined){
      if(!str(body.project)||!store.projectWorkspace(body.project))return bad("no such project");
      const identity=continuing??{workspaceId,owner:hub.hubOwner||"owner"} as any;
      if(!hub.canAccessRepo(identity,body.project))return bad("no repository access to this project");
      const repo=await repoStatus(hub.dataDir,body.project).catch(()=>null);
      if(repo?.main)canonical={project:body.project,base:repo.main,branch:`${name}/work-${Date.now().toString(36)}`};
    }
    // A continued agent gets a new token (whatever ran as it before is cut off) and moves to this device.
    let agentId: string, token: string;
    if (continuing) {
      const rotated = store.rotateAgentToken(continuing.name)!;
      agentId = rotated.id; token = rotated.token;
      store.setAgentDevice(agentId, device.name, device.id);
    } else ({ id: agentId, token } = store.addAgent({ name, owner: hub.hubOwner || "owner", device: device.name, skills: [], workspaceId, deviceId: device.id }));
    if (instructions !== undefined && (!continuing || instructions)) store.setInstructions(agentId, instructions);
    const request = store.addDeviceRequest({
      deviceId: device.id, kind: "launch", agentId, needsConfirmation: permissions === "open",
      payload: { ...canonical, agentName: name, token, harness, dir, permissions, model, provider: str(body.provider) ? body.provider : undefined, session, runCmd: str(body.runCmd) ? body.runCmd : undefined, resumeCmd: str(body.resumeCmd) ? body.resumeCmd : undefined, workspace: store.getWorkspace(workspaceId)?.name, reuse: !!continuing },
    });
    hub.notify();
    return c.json({ agent: name, request: deviceRequestsView(store).find((r) => r.id === request.id) });
  });

  // ---- the device ----
  const deviceOf = (header: string | undefined): Device | null => store.deviceByToken(header?.startsWith("Bearer ") ? header.slice(7) : "");

  app.post("/device/report", async (c) => {
    const device = deviceOf(c.req.header("authorization"));
    if (!device) return c.json({ error: "unauthorized" }, 401);
    const b = await c.req.json().catch(() => ({}));
    // A report is a snapshot: the device reads its folders, then spends seconds listing models, then sends. A report
    // started before `fleet device allow` can arrive after it, and must not put the old folders back on the hub.
    const rev = Number.isFinite(b?.rev) ? Math.max(0, Math.floor(b.rev)) : null;
    const known = device.info.rev ?? 0;
    if (rev !== null && rev < known) { store.touchDevice(device.id); return c.json({ ok: true, stale: true }); }
    const text = (v: unknown, n = 300) => (typeof v === "string" ? v.slice(0, n) : "");
    const harnesses = cap<any>(b?.harnesses, 20).filter((h) => h && str(h.id)).map((h) => ({ id: text(h.id, 20), label: text(h.label, 60), path: typeof h.path === "string" ? text(h.path) : null }));
    const harnessIds = new Set(harnesses.map((h) => h.id));
    // Where each model list came from, or why it is empty. Only text and numbers are kept, and only for harnesses the device reported.
    const modelInfo = Object.fromEntries(Object.entries(b?.modelInfo && typeof b.modelInfo === "object" ? b.modelInfo : {}).slice(0, 10)
      .filter(([id, v]) => (harnessIds.has(text(id, 20)) || text(id, 20) === "hermes") && !!v && typeof v === "object")   // hermes: catalog only, for the custom connector form
      .map(([id, v]: [string, any]) => [text(id, 20), {
        source: text(v.source, 200), found: Math.max(0, Math.min(10_000, Number(v.found) || 0)), at: Math.max(0, Number(v.at) || 0),
        ...(str(v.error) ? { error: text(v.error, 300) } : {}),
      }]));
    store.touchDevice(device.id, {
      hostname: text(b?.hostname, 100),
      harnesses,
      roots: cap<any>(b?.roots, 50).filter(str).map((r: string) => text(r)),
      models: Object.fromEntries(Object.entries(b?.models && typeof b.models === "object" ? b.models : {}).slice(0, 10).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [text(k, 20), cap<any>(v, 400).filter(str).map((m: string) => text(m, 100))])),
      modelInfo,
      usage: sanitiseUsage(b?.usage),
      sessions: cap<any>(b?.sessions, 300).filter((s) => s && str(s.id) && str(s.dir)).map((s) => ({ harness: text(s.harness, 20), id: text(s.id, 80), dir: text(s.dir), modified: Number(s.modified) || 0, preview: text(s.preview, 120) })),
      ...(rev !== null ? { rev } : known ? { rev: known } : {}),
    });
    hub.notify();
    return c.json({ ok: true });
  });

  app.post("/device/pull", (c) => {
    const device = deviceOf(c.req.header("authorization"));
    if (!device) return c.json({ error: "unauthorized" }, 401);
    store.touchDevice(device.id);
    const open = store.openDeviceRequests(device.id);
    for (const r of open) if (r.status === "pending") store.setDeviceRequest(r.id, "delivered", r.message ?? undefined);
    return c.json({ requests: open.map((r: DeviceRequest) => ({ id: r.id, kind: r.kind, payload: r.payload, needsConfirmation: r.needsConfirmation })) });
  });

  app.post("/device/requests/:id/result", async (c) => {
    const device = deviceOf(c.req.header("authorization"));
    if (!device) return c.json({ error: "unauthorized" }, 401);
    const r = store.getDeviceRequest(c.req.param("id"));
    if (!r || r.deviceId !== device.id) return c.json({ error: "no such request" }, 404);
    const b = await c.req.json().catch(() => ({}));
    if (!["done", "failed", "awaiting-confirmation"].includes(b?.status)) return c.json({ error: "status must be done, failed or awaiting-confirmation" }, 400);
    store.setDeviceRequest(r.id, b.status, typeof b.message === "string" ? b.message.slice(0, 300) : undefined);
    // An agent that never started must not leave a live token behind.
    if (b.status === "failed" && r.agentId && !r.payload.reuse) { const a = store.agentById(r.agentId); if (a) store.revokeAgent(a.name); }
    hub.notify();
    return c.json({ ok: true });
  });

  app.get("/device/events", (c) => {
    const device = deviceOf(c.req.header("authorization"));
    if (!device) return c.json({ error: "unauthorized" }, 401);
    return streamSSE(c, async (stream) => {
      let open = true, woke = false;
      const check = () => {
        if (!open) return;
        // A removed device is told at once, so its daemon stops instead of waiting for its next report to be refused.
        if (!store.getDevice(device.id)) { open = false; void stream.writeSSE({ event: "removed", data: "1" }).then(() => stream.close()); return; }
        const pending = store.openDeviceRequests(device.id).some((r) => r.status === "pending");
        if (pending && !woke) void stream.writeSSE({ event: "wake", data: "1" });
        woke = pending;
      };
      const off = hub.onChange(check);
      stream.onAbort(() => { open = false; off(); });
      await stream.writeSSE({ event: "hello", data: "1" });
      check();
      while (open) {
        await stream.sleep(15000);
        if (open) { store.touchDevice(device.id); await stream.writeSSE({ event: "ping", data: "1" }); }
      }
    });
  });
}
