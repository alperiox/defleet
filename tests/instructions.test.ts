import { test, expect } from "bun:test";
import { createApp } from "../src/app";
import { buildPrompt, processPending, type HelperConfig, type HelperIO } from "../helper/fleet-helper";

const H = { Authorization: "Bearer hs", "content-type": "application/json" };
const post = (app: any, path: string, body: unknown) => app.request(path, { method: "POST", headers: H, body: JSON.stringify(body) });

test("the human sets an agent's instructions; the state and the helper's pull carry them", async () => {
  const { app, store } = createApp(":memory:", "hs", { hubOwner: "alper" });
  const a = store.addAgent({ name: "web", owner: "alper", device: "d", skills: [] });
  expect((await post(app, "/api/agents/web/instructions", { instructions: "Work only in ~/site. Never push to main." })).status).toBe(200);
  expect((await post(app, "/api/agents/nobody/instructions", { instructions: "x" })).status).toBe(404);
  const state: any = await (await app.request("/api/state", { headers: H })).json();
  expect(state.agents.find((x: any) => x.name === "web").instructions).toBe("Work only in ~/site. Never push to main.");
  const pull: any = await (await app.request("/agent/pull", { method: "POST", headers: { Authorization: `Bearer ${a.token}`, "content-type": "application/json" }, body: "{}" })).json();
  expect(pull.self.instructions).toBe("Work only in ~/site. Never push to main.");
  // clearing works
  await post(app, "/api/agents/web/instructions", { instructions: "  " });
  expect(store.listAgents().find((x) => x.name === "web")!.instructions).toBe("");
});

test("instructions are capped, and an agent has no way to write its own", async () => {
  const { app, store } = createApp(":memory:", "hs", { hubOwner: "alper" });
  store.addAgent({ name: "web", owner: "alper", device: "d", skills: [] });
  const r = await post(app, "/api/agents/web/instructions", { instructions: "x".repeat(4001) });
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toMatch(/4000/);
  const src = await Bun.file(new URL("../src/mcp.ts", import.meta.url)).text();
  expect(src).not.toMatch(/instructions/i);
});

test("a launch from the UI can carry instructions, and continuing an agent keeps them", async () => {
  const { app, store } = createApp(":memory:", "hs", { hubOwner: "alper" });
  const d: any = await (await post(app, "/api/devices", { name: "laptop" })).json();
  const dev = { Authorization: `Bearer ${d.token}`, "content-type": "application/json" };
  await app.request("/device/report", { method: "POST", headers: dev, body: JSON.stringify({ hostname: "h", harnesses: [{ id: "claude", label: "Claude Code", path: "/usr/bin/claude" }], roots: ["/work"], sessions: [] }) });
  const res = await post(app, `/api/devices/${d.id}/launch`, { name: "web", harness: "claude", dir: "/work/site", permissions: "safe", instructions: "Reply briefly." });
  expect(res.status).toBe(200);
  expect(store.listAgents().find((x) => x.name === "web")!.instructions).toBe("Reply briefly.");
  // continuing without new text keeps what is there; with new text replaces it
  await post(app, `/api/devices/${d.id}/launch`, { asAgent: "web", harness: "claude", dir: "/work/site", permissions: "safe" });
  expect(store.listAgents().find((x) => x.name === "web")!.instructions).toBe("Reply briefly.");
  await post(app, `/api/devices/${d.id}/launch`, { asAgent: "web", harness: "claude", dir: "/work/site", permissions: "safe", instructions: "Be formal." });
  expect(store.listAgents().find((x) => x.name === "web")!.instructions).toBe("Be formal.");
  const tooLong = await post(app, `/api/devices/${d.id}/launch`, { name: "web2", harness: "claude", dir: "/work/site", instructions: "x".repeat(4001) });
  expect(tooLong.status).toBe(400);
  expect(store.listAgents().some((x) => x.name === "web2")).toBe(false);
});

const cfg = (extra: Partial<HelperConfig> = {}) => ({ hubUrl: "h", token: "t", harness: "claude", workdir: "/w", agentName: "web", ...extra }) as HelperConfig;

test("the helper puts the instructions in the prompt, labelled as the human's, for the team session only", () => {
  const items = [{ type: "message", message: { thread: "dm:x", from: "human", text: "hi" }, trust: "team", by: null }];
  const p = buildPrompt(items, cfg({ instructions: "Never push to main." }), null);
  expect(p).toMatch(/Standing instructions from your human/);
  expect(p).toMatch(/Never push to main\./);
  expect(buildPrompt(items, cfg(), null)).not.toMatch(/Standing instructions/);
  expect(buildPrompt(items, cfg({ instructions: "Never push to main." }), null, "quarantine")).not.toMatch(/Never push to main/);
});

test("a running helper learns edited and cleared instructions from the next hub pull", async () => {
  const { app, store, hub } = createApp(":memory:", "hs", { hubOwner: "alper" });
  const added = store.addAgent({ name: "web", owner: "alper", device: "d", skills: [] });
  const agent = store.agentById(added.id)!;
  const prompts: string[] = [];
  let started = false;
  const io: HelperIO = {
    pull: async (ack) => (await app.request("/agent/pull", {
      method: "POST", headers: { Authorization: `Bearer ${added.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ack }),
    })).json(),
    skills: async () => "Fleet protocol",
    run: async (cmd) => { prompts.push(cmd.argv[cmd.argv.indexOf("-p") + 1]); return { code: 0 }; },
    state: { started: () => started, markStarted: () => { started = true; } },
    log: () => {},
  };
  const config = cfg({ sessionId: "11111111-1111-4111-8111-111111111111", extraArgs: [] });
  for (const instruction of ["Reply briefly.", "Include evidence.", ""]) {
    await post(app, "/api/agents/web/instructions", { instructions: instruction });
    hub.humanSay("@web Handle the next message.", agent.workspaceId);
    expect(await processPending(config, io)).toBe("ok");
    expect(config.instructions).toBe(instruction);
    const prompt = prompts.at(-1)!;
    if (instruction) expect(prompt).toContain(instruction);
    else expect(prompt).not.toContain("Standing instructions from your human");
  }
  expect(prompts).toHaveLength(3);
  expect(prompts[1]).not.toContain("Reply briefly.");
  expect(prompts[2]).not.toContain("Include evidence.");
});
