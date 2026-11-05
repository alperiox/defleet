import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { launcherScript, pickHost, launchdPlist } from "../cli/fleet";

test("the host is the tailnet address when there is one, and loopback otherwise, with a reason either way", () => {
  expect(pickHost("100.100.100.100\n")).toEqual({ host: "100.100.100.100", reason: expect.stringMatching(/tailscale/i) });
  expect(pickHost("")).toEqual({ host: "127.0.0.1", reason: expect.stringMatching(/only this machine/i) });
  expect(pickHost("not-an-ip").host).toBe("127.0.0.1");
});

test("the launcher holds bun's full path and the tool's path", () => {
  const s = launcherScript("/opt/bun/bin/bun", "/home/me/agent-fleet/cli/fleet.ts");
  expect(s).toBe('#!/bin/sh\nexec "/opt/bun/bin/bun" "/home/me/agent-fleet/cli/fleet.ts" "$@"\n');
});

test("a login item can run any fleet command, not only an agent", () => {
  const xml = launchdPlist({ label: "dev.fleet.hub", bun: "/b", script: "/s.ts", name: "hub", args: ["hub", "run"], home: "/h", log: "/l" });
  expect(xml).toContain("<string>hub</string><string>run</string>");
});

// ---------- the whole first-run path, in a clean home folder ----------
const home = mkdtempSync(`${tmpdir()}/fleet-hubhome-`);
const data = mkdtempSync(`${tmpdir()}/fleet-hubdata-`);
const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
const port = probe.port!;
probe.stop(true);
async function fleet(...args: string[]) {
  const p = Bun.spawn([process.execPath, "run", "cli/fleet.ts", ...args], { env: { ...process.env, FLEET_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  return { out: out + err, code };
}
afterAll(async () => { await fleet("hub", "stop"); });

test("hub init sets everything up, starts the hub, signs this machine in, and shows the master token", async () => {
  const r = await fleet("hub", "init", "--owner", "tester", "--host", "127.0.0.1", "--port", String(port), "--dir", data, "--no-launcher");
  expect(r.code).toBe(0);
  const token = readFileSync(`${data}/human-token`, "utf8").trim();
  expect(token.length).toBeGreaterThanOrEqual(32);
  expect(r.out).toContain(token);                                    // the person is shown it, once, at the end
  expect(r.out).toContain(`http://127.0.0.1:${port}`);
  expect(r.out).toMatch(/install\.sh/);                              // and how to add another device
  expect(statSync(`${data}/human-token`).mode & 0o077).toBe(0);
  const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(JSON.parse(readFileSync(`${home}/login.json`, "utf8")).humanToken).toBe(token);   // `fleet agent add` works right away
}, 40000);

test("status, token and logs work, and a second init does not touch anything", async () => {
  const st = await fleet("hub", "status");
  expect(st.out).toMatch(/running/);
  expect(st.out).toContain(`127.0.0.1:${port}`);
  const token = readFileSync(`${data}/human-token`, "utf8").trim();
  expect((await fleet("hub", "token")).out.trim()).toBe(token);
  expect((await fleet("hub", "logs")).out).toMatch(/hub on 127\.0\.0\.1/);
  const again = await fleet("hub", "init", "--owner", "someone-else", "--no-launcher");
  expect(again.code).not.toBe(0);
  expect(again.out).toMatch(/already set up/i);
  expect(readFileSync(`${data}/human-token`, "utf8").trim()).toBe(token);
}, 30000);

test("agents can be added straight after init, with no separate login step", async () => {
  const work = mkdtempSync(`${tmpdir()}/fleet-hubwork-`);
  const r = await fleet("agent", "add", "first-agent", "--harness", "claude", "--dir", work, "--no-start");
  expect(r.code).toBe(0);
  expect(existsSync(`${home}/agents/first-agent.json`)).toBe(true);
}, 30000);

test("hub set changes the owner and restarts the hub on the same data", async () => {
  const r = await fleet("hub", "set", "--owner", "renamed");
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(`${home}/hub.json`, "utf8")).owner).toBe("renamed");
  expect((await fleet("hub", "status")).out).toMatch(/running.*owner renamed/);
}, 40000);

test("stop stops the hub and start brings it back with the same token and data", async () => {
  const token = readFileSync(`${data}/human-token`, "utf8").trim();
  expect((await fleet("hub", "stop")).code).toBe(0);
  expect((await fleet("hub", "status")).out).toMatch(/stopped/);
  expect((await fleet("hub", "start")).code).toBe(0);
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(state.agents.some((a: any) => a.name === "first-agent")).toBe(true);   // the database survived
}, 40000);
