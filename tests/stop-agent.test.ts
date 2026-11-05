import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import * as helper from "../helper/fleet-helper";
const fixtures: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.db.close(); rmSync(f.hub.dataDir, { recursive: true, force: true }); } });
function setup() {
 const f = createApp(":memory:", "human", { hubOwner: "owner" }); fixtures.push(f);
 const c = f.store.addAgent({ name: "worker", owner: "owner", device: "test", skills: [] }); const a = f.store.agentById(c.id)!;
 const req = (body: unknown, token = "human") => f.app.request("/api/agents/worker/stop", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
 return { ...f, a, token: c.token, req };
}
const cfg = (over: any = {}) => ({ hubUrl: "http://fixture", token: "fixture", harness: "custom", workdir: tmpdir(), sessionId: "same-session", model: "", extraArgs: [], quarantineSessionId: "quarantine", sandboxDir: tmpdir(), untrusted: "quarantine", provider: "", stateDir: tmpdir(), runCmd: "echo {prompt}", resumeCmd: "echo {session} {prompt}", ...over });
const msg = (id: number, text: string, trust = "owner") => ({ type: "message", trust, message: { id, thread: "dm:human:worker", from: "human", text } });

test("stop is human-only, idle is a no-op with DM, offline is explicit, bad attachment input cannot stop", async () => {
 const f = setup(); expect((await f.req({}, f.token)).status).toBe(401);
 const idle: any = await (await f.req({ text: "A new question" })).json(); expect(idle.stopped).toBe(false); expect(idle.reason).toBe("idle");
 expect(f.store.dmsWithHuman().at(-1)?.text).toBe("A new question");
 f.hub.setActivity(f.a, "working");
 const offline: any = await (await f.req({ text: "Are you there?" })).json(); expect(offline).toMatchObject({ stopped: false, reason: "offline" });
 expect((await f.req({ text: 42 })).status).toBe(400);
 expect((await f.req({ attachments: ["unknown"] })).status).toBe(400);
});

test("a working turn gets a scoped stop signal once, a normal attachment DM and human activity audit; claim remains held", async () => {
 const f = setup(); const task = f.hub.humanCreateTask({ title: "Work", project: "demo" }); f.hub.claim(f.a, task.id);
 const events: any[] = []; const off = (f.hub as any).onAgentStop(f.a.id, (e: any) => events.push(e));
 try {
  (f.hub as any).setActivity(f.a, "working", "long task", "turn-one");
  const up: any = await (await f.app.request("/api/artifacts?name=question.pdf", { method: "POST", headers: { authorization: "Bearer human", "content-type": "application/pdf" }, body: "%PDF-example" })).json();
  const res: any = await (await f.req({ text: "Please check this first", attachments: [up.id] })).json(); expect(res.stopped).toBe(true);
  expect(events).toEqual([expect.objectContaining({ type: "stop", turn: "turn-one" })]);
  await f.req({}); expect(events).toHaveLength(1);
  expect(f.store.getTask(task.id)?.claimedBy).toBe(f.a.id);
  expect(f.store.touchesFor()).toContainEqual(expect.objectContaining({ action: "human stopped worker", source: "human" }));
  expect(f.hub.pull(f.a).items.filter((i: any) => i.type === "message")[0]).toMatchObject({ message: { text: "Please check this first", attachments: [expect.objectContaining({ name: "question.pdf" })] } });
  (f.hub as any).setActivity(f.a, "idle", undefined, "turn-one");
  (f.hub as any).setActivity(f.a, "working", "new", "turn-two");
  await f.req({}); expect(events.at(-1).turn).toBe("turn-two");
 } finally { off(); }
});

test("existing agent SSE delivers stop JSON to only that helper", async () => {
 const f = setup(); const controller = new AbortController();
 const res = await f.app.fetch(new Request("http://fixture/agent/events", { headers: { authorization: `Bearer ${f.token}` }, signal: controller.signal }));
 const reader = res.body!.getReader(); await reader.read();
 (f.hub as any).setActivity(f.a, "working", "fixture", "stream-turn"); await f.req({});
 let data = ""; const deadline = Date.now() + 1000;
 try { while (!data.includes('"turn":"stream-turn"') && Date.now() < deadline) { const next: any = await Promise.race([reader.read(), Bun.sleep(1000).then(() => ({ value: new Uint8Array() }))]); data += new TextDecoder().decode(next.value); } }
 finally { controller.abort(); await reader.cancel(); }
 expect(data).toContain("event: stop"); expect(data).toContain('"type":"stop"');
});

test("helper acknowledges interrupted items once, preserves unstarted mixed-trust work, resumes with note and new human message", async () => {
 const f = setup();
 const outside = f.store.agentById(f.store.addAgent({ name: "outside", owner: "guest", device: "d", skills: [] }).id)!; f.hub.say(outside, "dm:worker", "Unstarted outside request");
 f.hub.humanDm("worker", "Original work"); f.hub.say(f.a, "dm:human", "not incoming");
 const c = cfg({ harness: "claude" }); const runs: helper.Command[] = [], logs: string[] = []; let started = true, checkpoint: any, rounds = 0;
 const io: any = {
  pull: async (ack: any) => f.hub.pull(f.a, ack), skills: async () => "",
  state: { started: () => started, markStarted: () => { started = true; }, interruption: () => checkpoint, setInterruption: (v: any) => { checkpoint = v; } },
  onStop: (fn: any) => (f.hub as any).onAgentStop(f.a.id, fn),
  activity: (state: any, note: any, turn: any) => (f.hub as any).setActivity(f.a, state, note, turn),
  run: async (cmd: helper.Command, signal: AbortSignal) => {
   runs.push(cmd); rounds++;
   if (rounds === 1) { await f.req({ text: "What did you change?" }); expect(signal.aborted).toBe(true); return { code: 143, stopped: true }; }
   return { code: 0 };
  }, log: (s: string) => logs.push(s),
 };
 expect(await helper.processPending(c, io)).toBe("ok"); expect(runs).toHaveLength(3);
 expect(runs[2].argv.join(" ")).toContain("Unstarted outside request");
 expect(runs[1].argv.join(" ")).toContain("same-session"); expect(runs[1].argv.join(" ")).toContain("Your previous turn was interrupted by the human"); expect(runs[1].argv.join(" ")).toContain("What did you change?");
 expect(logs).toContain("stopped by human"); expect(f.hub.pull(f.a).items).toEqual([]); expect(checkpoint).toBeFalsy();
});

test("real process-group runner stops sleep and its child, including TERM-resistant children", async () => {
 const dir = mkdtempSync(join(tmpdir(), "fleet-stop-test-")); const file = join(dir, "child"); const abort = new AbortController();
 let pid = 0;
 try {
  const run = (helper as any).runTurn({ argv: ["/bin/sh", "-c", `trap '' TERM; sleep 300 & echo $! > '${file}'; wait`], cwd: dir, env: {}, capture: true }, abort.signal, { graceMs: 100, onSpawn: (n: number) => { pid = n; } });
  const deadline = Date.now() + 2000; while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(10); expect(existsSync(file)).toBe(true);
  const child = Number(readFileSync(file, "utf8")); abort.abort(); const result = await run;
  expect(result.stopped).toBe(true); expect(() => process.kill(pid, 0)).toThrow();
  // macOS init may briefly retain a just-orphaned zombie; allow reaping before proving it gone.
  let live = true; for (let i = 0; i < 100; i++) { try { process.kill(child, 0); await Bun.sleep(10); } catch { live = false; break; } }
  expect(live).toBe(false);
 } finally { if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} } rmSync(dir, { recursive: true, force: true }); }
}, 10000);


test("first codex/agy interruption preserves captured sessions or safely starts fresh when none exists", async () => {
 for (const harness of ["codex", "antigravity"] as const) for (const captured of [true, false]) {
  const f = setup(); f.hub.humanDm("worker", "Start work");
  const id = harness === "codex" ? "01a19329-9069-7dd1-b5a1-ee5af7a024fd" : "conversation-123";
  const stdout = harness === "codex" ? JSON.stringify({ type: "thread.started", thread_id: id }) + "\n" : JSON.stringify({ status: "SUCCESS", conversation_id: id, response: "OK" });
  let started = false, checkpoint: any, count = 0; const commands: helper.Command[] = [];
  const c = cfg({ harness, sessionId: "" });
  const io: any = {
   pull: async (ack: any) => f.hub.pull(f.a, ack), skills: async () => "",
   state: { started: () => started, markStarted: () => { started = true; }, setSession: (s: string) => { c.sessionId = s; }, interruption: () => checkpoint, setInterruption: (v: any) => { checkpoint = v; } },
   onStop: (fn: any) => (f.hub as any).onAgentStop(f.a.id, fn), activity: async (s: any, note: any, turn: any) => (f.hub as any).setActivity(f.a, s, note, turn),
   run: async (cmd: helper.Command, signal: AbortSignal) => { commands.push(cmd); if (++count === 1) { await f.req({ text: "New question" }); return { code: 143, stopped: signal.aborted, stdout: captured ? stdout : "" }; } return { code: 0, stdout }; }, log: () => {},
  };
  expect(await helper.processPending(c, io)).toBe("ok"); expect(commands).toHaveLength(2);
  expect(commands[1].argv.join(" ")).toContain("interrupted by the human");
  expect(commands[1].argv.includes(harness === "codex" ? "resume" : "--conversation")).toBe(captured);
  expect(c.sessionId).toBe(id);
 }
});

test("interruption checkpoint retries exact ACK after network failure without replaying stopped work", async () => {
 const f = setup(); f.hub.humanDm("worker", "Initial"); let checkpoint: any, runs = 0, fail = true;
 const io: any = {
  pull: async (ack: any) => { if (ack?.interrupted && fail) { fail = false; throw new Error("network failure"); } return f.hub.pull(f.a, ack); }, skills: async () => "",
  state: { started: () => true, markStarted: () => {}, interruption: () => checkpoint, setInterruption: (v: any) => { checkpoint = JSON.parse(JSON.stringify(v)); } },
  onStop: (fn: any) => (f.hub as any).onAgentStop(f.a.id, fn), activity: async (s: any, note: any, turn: any) => (f.hub as any).setActivity(f.a, s, note, turn),
  run: async (_cmd: any, signal: AbortSignal) => { if (++runs === 1) { await f.req({ text: "After restart" }); return { code: 143, stopped: signal.aborted }; } expect(_cmd.argv.join(" ")).toContain("After restart"); expect(_cmd.argv.join(" ")).toContain("interrupted by the human"); return { code: 0 }; }, log: () => {},
 };
 await expect(helper.processPending(cfg(), io)).rejects.toThrow("network failure"); expect(checkpoint.ack.interrupted).toHaveLength(1);
 expect(await helper.processPending(cfg(), io)).toBe("ok"); expect(runs).toBe(2); expect(checkpoint).toBeNull();
});

test("stop before launch avoids spawning, late abort after exit cannot kill a later process, stale turn events are ignored", async () => {
 const aborted = new AbortController(); aborted.abort();
 expect(await (helper as any).runTurn({ argv: ["/bin/sleep", "300"], cwd: tmpdir(), env: {} }, aborted.signal)).toMatchObject({ stopped: true, launched: false });
 const old = new AbortController(); const done = await (helper as any).runTurn({ argv: ["/bin/sh", "-c", "exit 0"], cwd: tmpdir(), env: {} }, old.signal); old.abort(); expect(done.stopped).toBe(false);
 const f = setup(); let listener: any, turn = "", runs = 0;
 f.hub.humanDm("worker", "First");
 const io: any = { pull: async (ack: any) => f.hub.pull(f.a, ack), skills: async () => "", state: { started: () => true, markStarted: () => {} }, onStop: (fn: any) => { listener = fn; return () => {}; }, activity: async (_s: any, _n: any, id: string) => { if (!turn) turn = id; }, run: async (_c: any, signal: AbortSignal) => { if (++runs === 1) { listener({ turn: "wrong-turn" }); expect(signal.aborted).toBe(false); listener({ turn }); listener({ turn }); f.hub.humanDm("worker", "Second"); return { code: 143, stopped: true }; } listener({ turn }); expect(signal.aborted).toBe(false); return { code: 0 }; }, log: () => {} };
 expect(await helper.processPending(cfg(), io)).toBe("ok"); expect(runs).toBe(2);
});


test("stopping a later quarantine batch does not replay an already completed trusted batch", async () => {
 const f = setup(); f.hub.humanDm("worker", "Original completed owner work");
 const outside = f.store.agentById(f.store.addAgent({ name: "outside", owner: "guest", device: "d", skills: [] }).id)!;
 f.hub.say(outside, "dm:worker", "Outside request secret-prompt-injection"); const commands: string[] = []; let checkpoint: any;
 const io: any = {
  pull: async (ack: any) => f.hub.pull(f.a, ack), skills: async () => "", state: { started: () => true, markStarted: () => {}, interruption: () => checkpoint, setInterruption: (v: any) => { checkpoint = v; } },
  onStop: (fn: any) => f.hub.onAgentStop(f.a.id, fn), activity: async (s: any, n: any, t: any) => f.hub.setActivity(f.a, s, n, t),
  run: async (cmd: helper.Command, signal: AbortSignal) => { commands.push(cmd.argv.join(" ")); if (commands.length === 2) { await f.req({ text: "New owner question" }); return { code: 143, stopped: signal.aborted }; } return { code: 0 }; }, log: () => {},
 };
 expect(await helper.processPending(cfg({ harness: "claude" }), io)).toBe("ok"); expect(commands).toHaveLength(3);
 expect(commands[2]).toContain("New owner question"); expect(commands[2]).not.toContain("Original completed owner work"); expect(commands[2]).not.toContain("secret-prompt-injection");
 expect(f.hub.pull(f.a).items).toEqual([]);
});
