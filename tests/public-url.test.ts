import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { hubOrigin, resolvePublicUrl } from "../src/public-url";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => { for (const s of servers) s.stop(true); });

function hub(publicUrl?: string) {
  const { app, store } = createApp(":memory:", "human-secret", { hubOwner: "alper", publicUrl });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: human, body: JSON.stringify(body) });
  const get = (path: string) => fetch(`${base}${path}`);
  return { app, store, base, post, get };
}

test("with HUB_PUBLIC_URL every prompt and installer uses the public address, not the request origin", async () => {
  // The trailing slash is stripped: a prompt must not read https://hub.example.com//mcp or double-slash the join line.
  const h = hub("https://hub.example.com/");
  const pub = "https://hub.example.com";
  const created: any = await (await h.post("/api/agents/prompt", { name: "hermes-1" })).json();
  expect(created.prompt).toContain(`fleet join ${pub} `);
  const rotated: any = await (await h.post("/api/agents/hermes-1/token", {})).json();
  expect(rotated.prompt).toContain(`fleet join ${pub} `);
  const invited: any = await (await h.post("/api/external-agents", { name: "bo-laptop", owner: "bo" })).json();
  expect(invited.prompt).toContain(`fleet join ${pub} `);
  const md = await (await h.get("/install.md")).text();
  expect(md).toContain(`Hub: ${pub}`);
  const sh = await (await h.get("/install.sh")).text();
  expect(sh).toContain(`HUB='${pub}'`);
  // Nothing still points at the origin the tunnel talks to, and the stripped slash did not become a double slash.
  for (const text of [created.prompt, rotated.prompt, invited.prompt, md, sh]) {
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("hub.example.com//");
  }
});

test("without HUB_PUBLIC_URL the request origin is used, so tailnet use and the tests are unchanged", async () => {
  const h = hub();
  const created: any = await (await h.post("/api/agents/prompt", { name: "hermes-2" })).json();
  expect(created.prompt).toContain(`fleet join ${h.base} `);
  const rotated: any = await (await h.post("/api/agents/hermes-2/token", {})).json();
  expect(rotated.prompt).toContain(`fleet join ${h.base} `);
  const invited: any = await (await h.post("/api/external-agents", { name: "bo-phone", owner: "bo" })).json();
  expect(invited.prompt).toContain(`fleet join ${h.base} `);
  expect(await (await h.get("/install.md")).text()).toContain(`Hub: ${h.base}`);
  expect(await (await h.get("/install.sh")).text()).toContain(`HUB='${h.base}'`);
});

test("HUB_PUBLIC_URL is normalised, and a malformed value stops the hub from starting", () => {
  expect(resolvePublicUrl(undefined)).toBeUndefined();
  expect(resolvePublicUrl("   ")).toBeUndefined();
  expect(resolvePublicUrl(" https://hub.example.com/ ")).toBe("https://hub.example.com");
  expect(resolvePublicUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  for (const bad of [
    "hub.example.com",                       // no scheme: a prompt would not be copy-pasteable
    "ftp://hub.example.com",                 // not a web address
    "https://hub.example.com/hub",           // the hub is served at the root, so a path would make every URL wrong
    "https://hub.example.com?x=1",
    "https://hub.example.com#frag",
  ]) expect(() => resolvePublicUrl(bad)).toThrow(/HUB_PUBLIC_URL/);
  // The same check runs where the app is built, which is how server.ts passes the env var in: the hub refuses to start.
  expect(() => createApp(":memory:", "t", { publicUrl: "hub.example.com" })).toThrow(/HUB_PUBLIC_URL/);
  expect(hubOrigin("http://127.0.0.1:9/api", "https://public.example")).toBe("https://public.example");
  expect(hubOrigin("http://127.0.0.1:9/api")).toBe("http://127.0.0.1:9");
});


test("the real server refuses to start with a malformed HUB_PUBLIC_URL, before it opens the database", async () => {
  // The unit test above proves the validator; this proves server.ts actually passes the env var into it and fails loudly,
  // which is the part that would rot silently if the wiring changed.
  const dir = mkdtempSync(`${tmpdir()}/fleet-public-url-`);
  const p = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, HUB_PUBLIC_URL: "hub.example.com", HUB_HUMAN_TOKEN: "test-token", HUB_DB: `${dir}/hub.db`, HUB_PORT: "0", HUB_HOST: "127.0.0.1", HUB_OWNER: "alper" },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text(), err = await new Response(p.stderr).text();
  // If the wiring regressed the server would start and sit there; kill it and fail on the code instead of waiting for the test timeout.
  const code = await Promise.race([p.exited, Bun.sleep(5000).then(() => { p.kill(); return "still running"; })]);
  expect(code).toBe(1);
  expect(out + err).toMatch(/HUB_PUBLIC_URL/);
  expect(out + err).toMatch(/did not start/);
  expect(existsSync(`${dir}/hub.db`)).toBe(false);          // refused before openStore, so a typo leaves nothing behind
  rmSync(dir, { recursive: true, force: true });
}, 20000);
