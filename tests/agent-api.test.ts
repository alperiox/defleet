import { test, expect, afterAll } from "bun:test";
import { createApp } from "../src/app";

const { app, hub, store } = createApp(":memory:", "human-secret");
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

const { token } = store.addAgent({ name: "claude-laptop", owner: "alper", device: "laptop", skills: [] });
const bearer = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
const pull = async (ack?: unknown) =>
  (await fetch(`${base}/agent/pull`, { method: "POST", headers: bearer, body: JSON.stringify({ ack }) })).json();

test("agent endpoints reject a missing, wrong or human token", async () => {
  for (const h of [{} as Record<string, string>, { Authorization: "Bearer nope" }, { Authorization: "Bearer human-secret" }]) {
    expect((await fetch(`${base}/agent/pull`, { method: "POST", headers: h })).status).toBe(401);
    expect((await fetch(`${base}/agent/events`, { headers: h })).status).toBe(401);
  }
});

test("pull returns pending work without blocking, repeats it until acked, then goes quiet", async () => {
  hub.humanDm("claude-laptop", "please start on the dashboard");
  const first = await pull();
  expect(first.items.length).toBe(1);
  expect(first.items[0].message.text).toBe("please start on the dashboard");
  const again = await pull();
  expect(again.items.length).toBe(1);
  const done = await pull(first.ack);
  expect(done.items.length).toBe(0);
});

test("the event stream sends 'wake' when work arrives for this agent only", async () => {
  const res = await fetch(`${base}/agent/events`, { headers: bearer });
  const reader = res.body!.getReader();
  const seen: string[] = [];
  let inflight: ReturnType<typeof reader.read> | null = null; // never start a second read while one is pending
  const read = async (until: string, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !seen.join("").includes(until)) {
      inflight ??= reader.read();
      const r = await Promise.race([inflight, new Promise<null>((r) => setTimeout(() => r(null), 100))]);
      if (r) { inflight = null; if (!r.done) seen.push(new TextDecoder().decode(r.value)); }
    }
    return seen.join("").includes(until);
  };
  expect(await read("event: hello")).toBe(true);
  expect(seen.join("")).not.toContain("event: wake");
  hub.humanSay("unrelated chatter without a mention");
  expect(await read("event: wake", 700)).toBe(false);
  hub.humanDm("claude-laptop", "wake up");
  expect(await read("event: wake")).toBe(true);
  await reader.cancel();
});

test("a stream that connects while work is already pending is woken at once", async () => {
  const res = await fetch(`${base}/agent/events`, { headers: bearer });
  const reader = res.body!.getReader();
  let text = "";
  const end = Date.now() + 3000;
  while (Date.now() < end && !text.includes("event: wake")) {
    const r = await reader.read();
    if (!r.done) text += new TextDecoder().decode(r.value);
  }
  await reader.cancel();
  expect(text).toContain("event: wake");
});

test("the helper script is served without authentication", async () => {
  const res = await fetch(`${base}/helper.ts`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("fleet-helper");
});

test("the hub serves the install instructions with its own address, and never a token", async () => {
  const res = await fetch(`${base}/install.md`);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain(`fleet join ${base} <token>`);
  expect(text).toContain("--harness custom");
});

test("the hub serves an installer script for the fleet command", async () => {
  const res = await fetch(`${base}/install.sh`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain(`HUB='${base}'`);
});

test("the helper and the fleet command are served as single files that run on their own, with the shared harness table inlined", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/fleet-served-`);
  for (const name of ["helper.ts", "fleet.ts"]) {
    const text = await (await fetch(`${base}/${name}`)).text();
    expect(text).not.toMatch(/from\s+["']\.\.?\//);              // no relative imports left: a device has no repository
    expect(text).toContain("Claude Code");                             // the registry is in there
    writeFileSync(`${dir}/${name}`, text);
  }
  const p = Bun.spawn([process.execPath, `${dir}/fleet.ts`], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: dir } });
  expect(await new Response(p.stdout).text()).toMatch(/fleet: manage fleet agents/);
  expect(await p.exited).toBe(0);
  const h = Bun.spawn([process.execPath, `${dir}/helper.ts`, "check"], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: dir } });
  expect(await new Response(h.stderr).text()).toMatch(/FLEET_HARNESS|is required/);      // it starts and asks for its settings, rather than failing to load
  await h.exited;
});
