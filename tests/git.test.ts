import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createApp } from "../src/app";

// Each case gets its own limiter window; authentication assertions remain unchanged.
let authNow = Date.now();
beforeEach(() => { authNow += 60_001; });
const { app, store } = createApp(":memory:", "human-secret", { security: { now: () => authNow } });
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
afterAll(() => server.stop(true));

const a = store.addAgent({ name: "claude-laptop", owner: "alper", device: "d", skills: [] });
const b = store.addAgent({ name: "opencode-mac", owner: "alper", device: "d", skills: [] });
const url = (token: string, project = "kapi", user = "agent") => `http://${user}:${token}@localhost:${server.port}/git/${project}.git`;

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: cwd },
  });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  return { out, err, code };
}
const dir = () => mkdtempSync(`${tmpdir()}/fleet-git-`);

test("an agent can create a project repo by pushing to its own branch, and another agent can fetch it", async () => {
  const w1 = dir();
  await git(w1, "init");
  writeFileSync(`${w1}/hello.txt`, "hello from the laptop\n");
  await git(w1, "add", ".");
  await git(w1, "commit", "-m", "first");
  const push = await git(w1, "push", url(a.token), "HEAD:refs/heads/claude-laptop/main");
  expect(push.code).toBe(0);

  const w2 = dir();
  const clone = await git(w2, "clone", url(b.token), "copy");
  expect(clone.code).toBe(0);
  const br = await git(`${w2}/copy`, "branch", "-r");
  expect(br.out).toContain("origin/claude-laptop/main");
  const show = await git(`${w2}/copy`, "show", "origin/claude-laptop/main:hello.txt");
  expect(show.out).toBe("hello from the laptop\n");
});

test("an agent cannot push to main or to another agent's branches", async () => {
  const w = dir();
  await git(w, "init");
  writeFileSync(`${w}/x.txt`, "x\n");
  await git(w, "add", ".");
  await git(w, "commit", "-m", "x");
  const toMain = await git(w, "push", url(b.token), "HEAD:refs/heads/main");
  expect(toMain.code).not.toBe(0);
  expect(toMain.err).toContain("opencode-mac/");
  const toOther = await git(w, "push", url(b.token), "HEAD:refs/heads/claude-laptop/hijack");
  expect(toOther.code).not.toBe(0);
  const own = await git(w, "push", url(b.token), "HEAD:refs/heads/opencode-mac/tests");
  expect(own.code).toBe(0);
});

test("an agent cannot delete another agent's branch", async () => {
  const w = dir();
  await git(w, "init");
  const del = await git(w, "push", url(b.token), ":refs/heads/claude-laptop/main");
  expect(del.code).not.toBe(0);
});

test("no credentials, a wrong token, a revoked token and a bad project name are all refused", async () => {
  const w = dir();
  await git(w, "init");
  writeFileSync(`${w}/y.txt`, "y\n");
  await git(w, "add", ".");
  await git(w, "commit", "-m", "y");
  expect((await git(w, "ls-remote", `http://localhost:${server.port}/git/kapi.git`)).code).not.toBe(0);
  expect((await git(w, "ls-remote", url("wrong"))).code).not.toBe(0);
  const c = store.addAgent({ name: "temp-agent", owner: "alper", device: "d", skills: [] });
  expect((await git(w, "ls-remote", url(c.token))).code).toBe(0);
  store.revokeAgent("temp-agent");
  expect((await git(w, "ls-remote", url(c.token))).code).not.toBe(0);
  const res = await fetch(`http://localhost:${server.port}/git/..%2Fescape.git/info/refs?service=git-upload-pack`, {
    headers: { Authorization: "Basic " + btoa(`x:${a.token}`) },
  });
  expect([400, 404]).toContain(res.status);
});

test("the human API lists repos with their branches, newest commit message and who owns each branch", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/repos`, { headers: { Authorization: "Bearer human-secret" } });
  expect(res.status).toBe(200);
  const repos = await res.json();
  const kapi = repos.find((r: any) => r.project === "kapi");
  expect(kapi).toBeTruthy();
  const main = kapi.branches.find((b: any) => b.name === "claude-laptop/main");
  expect(main.subject).toBe("first");
  expect(main.sha).toMatch(/^[0-9a-f]{7,}$/);
  expect((await fetch(`http://localhost:${server.port}/api/repos`)).status).toBe(401);
});

test("a repository with a large file can be pushed and cloned through the hub", async () => {
  const w = dir();
  await git(w, "init");
  const big = new Uint8Array(12 * 1024 * 1024);
  crypto.getRandomValues(big.subarray(0, 65536));
  for (let i = 65536; i < big.length; i += 65536) big.set(big.subarray(0, 65536), i); // compressible but large on the wire for the first chunk
  writeFileSync(`${w}/big.bin`, big);
  await git(w, "add", ".");
  await git(w, "commit", "-m", "big");
  const push = await git(w, "push", url(a.token, "bigrepo"), "HEAD:refs/heads/claude-laptop/big");
  expect(push.code).toBe(0);
  const c = dir();
  const clone = await git(c, "clone", "--branch", "claude-laptop/big", url(b.token, "bigrepo"), "copy");
  expect(clone.code).toBe(0);
  const size = (await Bun.file(`${c}/copy/big.bin`).arrayBuffer()).byteLength;
  expect(size).toBe(big.length);
});
