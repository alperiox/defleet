import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createApp } from "../src/app";
import { uploadArtifact, gitRemoteUrl, cleanGitUrl, gitCredentialHelper } from "../helper/fleet-helper";
import { DOC } from "./fixtures";

const { app, hub, store } = createApp(":memory:", "human-secret");
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
afterAll(() => server.stop(true));
const base = `http://localhost:${server.port}`;
const a = store.addAgent({ name: "claude-laptop", owner: "alper", device: "d", skills: [] });
const A = store.agentById(a.id)!;
const t = hub.createTask(A, { title: "visual", project: "kapi", ...DOC });
hub.claim(A, t.id);

test("the helper's upload command attaches a file to a task and reports what it stored", async () => {
  const f = `${mkdtempSync(`${tmpdir()}/fleet-cli-`)}/panel shot.png`;
  writeFileSync(f, new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
  const r = await uploadArtifact({ hubUrl: base, token: a.token }, t.key, f, "screenshot");
  expect(r.name).toBe("panel_shot.png");
  expect(r.size).toBe(7);
  expect(store.artifactsFor(t.id)[0].kind).toBe("screenshot");
});

test("upload surfaces the hub's reason when it is refused", async () => {
  const f = `${mkdtempSync(`${tmpdir()}/fleet-cli-`)}/x.png`;
  writeFileSync(f, "x");
  await expect(uploadArtifact({ hubUrl: base, token: a.token }, "NOPE-9", f, "screenshot")).rejects.toThrow(/no such task/);
  await expect(uploadArtifact({ hubUrl: base, token: "bad" }, t.key, f, "screenshot")).rejects.toThrow(/unauthorized/);
  await expect(uploadArtifact({ hubUrl: base, token: a.token }, t.key, "/definitely/not/here.png", "screenshot")).rejects.toThrow(/cannot read/);
});

test("git-remote builds a URL a plain git client can use", () => {
  expect(gitRemoteUrl({ hubUrl: "http://hub:8787", token: "abc123" }, "kapi")).toBe("http://agent:abc123@hub:8787/git/kapi.git");
});

test("skills documents are served to anyone, unknown names are 404, and traversal is refused", async () => {
  for (const n of ["outcome-report", "screenshots", "demo-video", "shared-code"]) {
    const r = await fetch(`${base}/skills/${n}.md`);
    expect(r.status).toBe(200);
    expect((await r.text()).length).toBeGreaterThan(300);
  }
  expect((await fetch(`${base}/skills/outcome-report.md`).then((r) => r.text()))).toContain("attach_report");
  expect((await fetch(`${base}/skills/nope.md`)).status).toBe(404);
  expect((await fetch(`${base}/skills/..%2Fsrc%2Fhub.ts`)).status).toBe(404);
  expect((await fetch(`${base}/skills/%2e%2e%2fpackage.json`)).status).toBe(404);
});

test("the clean git URL carries no token, and the credential helper reads the token from the environment at push time", async () => {
  expect(cleanGitUrl("http://hub:8787", "kapi")).toBe("http://hub:8787/git/kapi.git");
  const helper = gitCredentialHelper();
  // git runs it as `sh -c '<helper> get'` and reads username/password lines from stdout
  const run = async (arg: string, env: Record<string, string>) => {
    const p = Bun.spawn(["sh", "-c", `${helper.slice(1)} ${arg}`], { env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" });
    return [await new Response(p.stdout).text(), await p.exited] as const;
  };
  const [out] = await run("get", { FLEET_TOKEN: "tok-new" });
  expect(out).toBe("username=agent\npassword=tok-new\n");        // a rotated token is picked up with no change to any remote
  expect((await run("store", { FLEET_TOKEN: "tok-new" }))[0]).toBe(""); // it never stores anything
});
