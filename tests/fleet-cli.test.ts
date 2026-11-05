import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { createApp } from "../src/app";
import { parseArgs, extraArgsFor, launchdPlist, joinLines, permissionNote, validName, normalizeHarness, installInstructions, installScript, validateSession, claudeProjectDir, listClaudeSessions, listCodexSessions, parseOpencodeModels, parsePrimeModels, parseCodexModels, parseClaudeModelAliases, parseAgyModels, collectModels, discoverModels, discoverHermesModels, MODEL_CACHE_MS, MODEL_ERROR_CACHE_MS } from "../cli/fleet";

// This file drives the real device daemon and report path. Usage measurement shells out to the installed harnesses
// (claude, agy, opencode), so it is switched off here: the Usage tab's own tests inject a runner instead.
process.env.FLEET_USAGE = "off";

test("arguments parse into words and flags, with boolean flags and = values", () => {
  const a = parseArgs(["agent", "add", "my-agent", "--harness", "claude", "--no-start", "--dir=/tmp/x", "--ssh", "mac"]);
  expect(a._).toEqual(["agent", "add", "my-agent"]);
  expect(a.flags).toEqual({ harness: "claude", "no-start": true, dir: "/tmp/x", ssh: "mac" });
});

test("permissions map to the harness flags, and the default grants nothing extra", () => {
  expect(extraArgsFor("claude", "safe")).toEqual([]);
  expect(extraArgsFor("claude", "edits")).toEqual(["--permission-mode", "acceptEdits"]);
  expect(extraArgsFor("claude", "open")).toEqual(["--dangerously-skip-permissions"]);
  expect(extraArgsFor("opencode", "safe")).toEqual([]);
  expect(extraArgsFor("opencode", "open")).toEqual(["--auto"]);
  expect(() => extraArgsFor("opencode", "edits")).toThrow(/safe or open/);
  expect(() => extraArgsFor("claude", "bogus" as any)).toThrow(/permissions/);
});

test("antigravity: the run carries its own limits, and the fleet tools are the exception they must keep", () => {
  const safe = extraArgsFor("antigravity", "safe");
  expect(safe[0]).toBe("--settings");
  const safeCfg = JSON.parse(safe[1]);
  // request-review is the preset that asks first; "strict" ignores even allow rules, so the fleet tools themselves would be refused.
  expect(safeCfg.toolPermission).toBe("request-review");
  expect(safeCfg.allowNonWorkspaceAccess).toBe(false);
  expect(safeCfg.permissions.allow).toEqual(["mcp(fleet/*)"]);           // nobody is at the keyboard to approve a fleet tool
  for (const rule of ["read_file(*)", "write_file(*)", "command(*)", "read_url(*)", "execute_url(*)"]) expect(safeCfg.permissions.deny).toContain(rule);
  expect(safeCfg.permissions.ask).toEqual([]);                           // an inherited ask rule cannot block the fleet tools
  expect(safe).not.toContain("--mode");                                  // safe is the default mode; accept-edits would widen it

  const edits = extraArgsFor("antigravity", "edits");
  const editsCfg = JSON.parse(edits[edits.indexOf("--settings") + 1]);
  expect(editsCfg.permissions.deny).toContain("command(*)");
  expect(editsCfg.permissions.deny).not.toContain("write_file(*)");      // editing files in its folder is the point of "edits"
  expect(editsCfg.permissions.deny).not.toContain("read_file(*)");
  expect(editsCfg.allowNonWorkspaceAccess).toBe(false);
  expect(edits.slice(edits.indexOf("--mode") + 1, edits.indexOf("--mode") + 2)).toEqual(["accept-edits"]);

  expect(extraArgsFor("antigravity", "open")).toEqual(["--dangerously-skip-permissions"]);
  // An unknown level is refused, not silently treated as one of the three.
  expect(() => extraArgsFor("antigravity", "yolo" as any)).toThrow(/safe, edits or open/);
});

test("antigravity: the settings it is given hold no spaces, so they survive being passed through one environment string", () => {
  for (const p of ["safe", "edits"] as const) {
    const args = extraArgsFor("antigravity", p);
    for (const a of args) expect(a).not.toMatch(/\s/);
  }
});

test("antigravity: the note says what the agent can do, and does not promise a sandbox it does not have", () => {
  expect(permissionNote("antigravity", "safe")).toMatch(/fleet tools only/i);
  expect(permissionNote("antigravity", "safe")).toMatch(/not an OS sandbox/i);
  expect(permissionNote("antigravity", "safe")).toMatch(/refused/i);
  expect(permissionNote("antigravity", "edits")).toMatch(/edit files/i);
  expect(permissionNote("antigravity", "edits")).toMatch(/not an OS sandbox/i);
  expect(permissionNote("antigravity", "open")).toMatch(/anywhere|anything/i);
});

test("the permission note says plainly what the agent will be able to do", () => {
  expect(permissionNote("claude", "safe")).toMatch(/fleet tools only/i);
  expect(permissionNote("claude", "open")).toMatch(/anything/i);
});

test("names are lowercase letters, digits and dashes", () => {
  for (const ok of ["claude-laptop", "a", "agent-2"]) expect(validName(ok)).toBe(true);
  for (const bad of ["", "Has Space", "../x", "UPPER", "a".repeat(41), "-lead"]) expect(validName(bad)).toBe(false);
});

test("the launchd plist runs the agent at login, restarts it, and escapes its values", () => {
  const xml = launchdPlist({ label: "dev.fleet.agent.a-1", bun: "/usr/local/bin/bun", script: "/Users/x/.fleet/fleet.ts", name: "a-1", home: "/Users/x/.fleet", log: "/Users/x/.fleet/logs/a-1.log" });
  expect(xml).toContain("<key>RunAtLoad</key><true/>");
  expect(xml).toContain("<key>KeepAlive</key><true/>");
  expect(xml).toContain("<string>run</string><string>a-1</string>");
  expect(xml).toContain("/Users/x/.fleet/fleet.ts");
  expect(launchdPlist({ label: "l", bun: "/b", script: "/s&<>.ts", name: "n", home: "/h", log: "/l" })).toContain("/s&amp;&lt;&gt;.ts");
});

test("the join instructions for another person's device are copy-pasteable and never print the token twice", () => {
  const lines = joinLines("http://hub.example:8787", "tok123", { name: "friend-agent", harness: "claude", permissions: "safe" });
  const text = lines.join("\n");
  expect(text).toContain("curl -fsSL http://hub.example:8787/fleet.ts");
  expect(text).toContain("join http://hub.example:8787");
  expect(text).toContain("--name friend-agent");
  expect(text.split("tok123").length - 1).toBe(1);
});

test("prime-agent has no safe mode: it needs open, and says why", () => {
  expect(() => extraArgsFor("prime", "safe")).toThrow(/Python REPL/);
  expect(() => extraArgsFor("prime", "edits")).toThrow(/Python REPL/);
  expect(extraArgsFor("prime", "open")).toEqual([]);
  expect(permissionNote("prime", "open")).toMatch(/Python REPL/);
});

test("harness names are normalised, and unknown ones are rejected", () => {
  expect(normalizeHarness("prime-agent")).toBe("prime");
  expect(normalizeHarness("claude")).toBe("claude");
  expect(normalizeHarness("opencode")).toBe("opencode");
  expect(normalizeHarness("custom")).toBe("custom");
  expect(normalizeHarness("hermes")).toBeNull();
  expect(normalizeHarness(true)).toBeNull();
});

test("a custom harness has no safe mode either: it needs open, and says why", () => {
  expect(() => extraArgsFor("custom", "safe")).toThrow(/cannot limit/);
  expect(extraArgsFor("custom", "open")).toEqual([]);
  expect(permissionNote("custom", "open")).toMatch(/cannot be sandboxed/);
});

test("the install instructions give a ready line for each built-in harness and a procedure for anything else", () => {
  const t = installInstructions({ hubUrl: "http://hub:8787", token: "tok-abc", name: "helper-1" });
  for (const h of ["claude", "opencode", "prime-agent"]) expect(t).toContain(`--harness ${h}`);
  expect(t).toContain("fleet join http://hub:8787 tok-abc --name helper-1");
  expect(t).toMatch(/--harness custom/);
  for (const s of ["{prompt}", "{session}", "--run-cmd", "--resume-cmd", "http://hub:8787/mcp", "FLEET_TOKEN"]) expect(t).toContain(s);
  expect(t).toMatch(/self-check/i);
  expect(t).toContain("curl -fsSL http://hub:8787/install.sh | sh");   // a friend may not have the command yet
  expect(t).toMatch(/never (paste|repeat|print)/i);
});

test("without a hub and token the instructions use placeholders instead of inventing values", () => {
  const t = installInstructions({});
  expect(t).toContain("<hub-url>");
  expect(t).toContain("<token>");
});

// ---------- end to end against a real hub, in an isolated home folder ----------
const { app, store } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
const url = `http://127.0.0.1:${server.port}`;
const home = mkdtempSync(`${tmpdir()}/fleet-home-`);
const work = mkdtempSync(`${tmpdir()}/fleet-work-`);
// Claude keeps sessions per folder; give it a home with two sessions for `work`, so importing can be tried without touching the real one.
const claudeHome = mkdtempSync(`${tmpdir()}/fleet-claude-home-`);
for (const id of ["bf26ea24-5be5-4119-954f-199f787baf9d", "11111111-1111-4111-8111-111111111111"]) {
  const d = claudeProjectDir(work, claudeHome); mkdirSync(d, { recursive: true }); writeFileSync(`${d}/${id}.jsonl`, JSON.stringify({ type: "user", message: { role: "user", content: "hello from " + id.slice(0, 4) } }) + "\n");
}
async function fleet(...args: string[]) {
  const p = Bun.spawn([process.execPath, "run", "cli/fleet.ts", ...args], { env: { ...process.env, FLEET_HOME: home, FLEET_CLAUDE_HOME: claudeHome }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  return { out: out + err, code };
}
afterAll(async () => {
  // Stop every helper this file started, whatever its name, so a test run leaves nothing behind.
  const configured = existsSync(`${home}/agents`) ? readdirSync(`${home}/agents`).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  for (const name of configured) await fleet("stop", name);
  server.stop(true);
});

test("login checks the human token and stores it privately", async () => {
  expect((await fleet("login", url, "wrong")).code).not.toBe(0);
  const ok = await fleet("login", url, "human-secret");
  expect(ok.code).toBe(0);
  expect(statSync(`${home}/login.json`).mode & 0o077).toBe(0);
});

test("agent add creates the agent on the hub, sets it up here, starts its helper, and reports it online", async () => {
  const r = await fleet("agent", "add", "e2e-agent", "--harness", "claude", "--dir", work);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/online/i);
  expect(r.out).toMatch(/fleet tools only/i);
  expect(store.listAgents().some((a) => a.name === "e2e-agent")).toBe(true);
  const cfg = JSON.parse(readFileSync(`${home}/agents/e2e-agent.json`, "utf8"));
  expect(cfg.harness).toBe("claude");
  expect(cfg.workdir).toBe(work);
  expect(statSync(`${home}/agents/e2e-agent.json`).mode & 0o077).toBe(0);
  expect(JSON.stringify(await (await fetch(`${url}/api/state`, { headers: { Authorization: "Bearer human-secret" } })).json())).not.toContain(cfg.token);
  const ls = await fleet("ls");
  expect(ls.out).toContain("e2e-agent");
  expect(ls.out).toMatch(/running/);
}, 40000);

test("adding the same name again is refused with the hub's reason", async () => {
  const r = await fleet("agent", "add", "e2e-agent", "--harness", "claude", "--dir", work);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/already exists/);
}, 20000);

test("stop stops the helper; start brings it back", async () => {
  expect((await fleet("stop", "e2e-agent")).code).toBe(0);
  expect((await fleet("ls")).out).toMatch(/stopped/);
  const s = await fleet("start", "e2e-agent");
  expect(s.code).toBe(0);
  expect((await fleet("ls")).out).toMatch(/running/);
}, 40000);

test("an unsafe permission level is written to the config but never started by --no-start, and it is spelled out", async () => {
  const r = await fleet("agent", "add", "e2e-two", "--harness", "claude", "--dir", work, "--permissions", "open", "--no-start");
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/anything/i);
  const cfg = JSON.parse(readFileSync(`${home}/agents/e2e-two.json`, "utf8"));
  expect(cfg.permissions).toBe("open");
  expect((await fleet("ls")).out).toMatch(/e2e-two.*stopped/);
});

test("print-join creates the agent but sets nothing up here, and prints one command for the other device", async () => {
  const r = await fleet("agent", "add", "friend-agent", "--owner", "sam", "--harness", "claude", "--print-join");
  expect(r.code).toBe(0);
  expect(r.out).toContain("fleet.ts");
  expect(r.out).toContain("--name friend-agent");
  expect(existsSync(`${home}/agents/friend-agent.json`)).toBe(false);
  expect(store.listAgents().find((a) => a.name === "friend-agent")?.owner).toBe("sam");
});

test("agent rm revokes the token on the hub, removes it here, and frees the name", async () => {
  const cfg = JSON.parse(readFileSync(`${home}/agents/e2e-agent.json`, "utf8"));
  const r = await fleet("agent", "rm", "e2e-agent");
  expect(r.code).toBe(0);
  expect(store.agentByToken(cfg.token)).toBeNull();
  expect(existsSync(`${home}/agents/e2e-agent.json`)).toBe(false);
  expect((await fleet("ls")).out).not.toMatch(/e2e-agent.*running/);
  expect((await fleet("agent", "add", "e2e-agent", "--harness", "claude", "--dir", work, "--no-start")).code).toBe(0);
}, 40000);

test("doctor reports the hub and each agent, and says what is wrong", async () => {
  const r = await fleet("doctor");
  expect(r.out).toMatch(/hub/i);
  expect(r.out).toMatch(/bun/i);
  expect(r.out).toContain("e2e-two");
});

test("a prime-agent needs a model and an explicit open permission before anything is created on the hub", async () => {
  const before = store.listAgents().length;
  const noPerm = await fleet("agent", "add", "prime-one", "--harness", "prime-agent", "--model", "gpt-5.6-luna", "--dir", work, "--no-start");
  expect(noPerm.code).not.toBe(0);
  expect(noPerm.out).toMatch(/Python REPL/);
  const noModel = await fleet("agent", "add", "prime-one", "--harness", "prime", "--permissions", "open", "--dir", work, "--no-start");
  expect(noModel.code).not.toBe(0);
  expect(noModel.out).toMatch(/--model/);
  expect(store.listAgents().length).toBe(before);
  const ok = await fleet("agent", "add", "prime-one", "--harness", "prime-agent", "--model", "gpt-5.6-luna", "--permissions", "open", "--dir", work, "--no-start");
  expect(ok.code).toBe(0);
  const cfg = JSON.parse(readFileSync(`${home}/agents/prime-one.json`, "utf8"));
  expect(cfg.harness).toBe("prime");
  expect(cfg.model).toBe("gpt-5.6-luna");
  expect(cfg.provider).toBe("opencode-go");
  expect(ok.out).toMatch(/Python REPL/);
}, 30000);

// ---------- custom harness: an agent that wrote its own command ----------
// A stand-in for "some agent tool": it remembers each session's prompt in a file and prints it back when resumed.
const botDir = mkdtempSync(`${tmpdir()}/fleet-bot-`);
writeFileSync(`${botDir}/bot.ts`, `import { writeFileSync, readFileSync, existsSync } from "node:fs";
const [mode, session, prompt] = process.argv.slice(2);
const f = "${botDir}/" + session;
if (mode === "new") { writeFileSync(f, prompt); console.log("OK"); }
else if (mode === "resume") console.log(existsSync(f) ? readFileSync(f, "utf8") : "no such session");
else if (mode === "forgetful") console.log("OK");
else process.exit(3);
`);
const bot = (mode: string) => `${process.execPath} ${botDir}/bot.ts ${mode} {session} {prompt}`;

test("a custom agent is refused without a run command or without the open permission, before anything is created", async () => {
  const before = store.listAgents().length;
  const noCmd = await fleet("agent", "add", "bot-one", "--harness", "custom", "--permissions", "open", "--dir", work, "--no-start");
  expect(noCmd.code).not.toBe(0);
  expect(noCmd.out).toMatch(/--run-cmd/);
  const noPerm = await fleet("agent", "add", "bot-one", "--harness", "custom", "--run-cmd", bot("new"), "--dir", work, "--no-start");
  expect(noPerm.code).not.toBe(0);
  expect(noPerm.out).toMatch(/cannot limit/);
  expect(store.listAgents().length).toBe(before);
}, 20000);

test("joining with a custom command runs the self-check and keeps the commands in the config", async () => {
  const r = await fleet("agent", "add", "bot-two", "--harness", "custom", "--permissions", "open", "--dir", work, "--run-cmd", bot("new"), "--resume-cmd", bot("resume"), "--no-start");
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/self-check passed/i);
  const cfg = JSON.parse(readFileSync(`${home}/agents/bot-two.json`, "utf8"));
  expect(cfg.harness).toBe("custom");
  expect(cfg.runCmd).toContain("bot.ts new");
  expect(cfg.resumeCmd).toContain("bot.ts resume");
}, 40000);

test("a resume command that forgets the session fails the self-check, and no config is written", async () => {
  const r = await fleet("agent", "add", "bot-three", "--harness", "custom", "--permissions", "open", "--dir", work, "--run-cmd", bot("new"), "--resume-cmd", bot("forgetful"), "--no-start");
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/did not remember/);
  expect(r.out).toMatch(/token is still valid/i);
  expect(existsSync(`${home}/agents/bot-three.json`)).toBe(false);
}, 40000);

test("the install command prints the instructions with the hub's address", async () => {
  const r = await fleet("install", "--hub", url, "--token", "tok-xyz", "--name", "someone");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`fleet join ${url} tok-xyz --name someone`);
});

test("add with --print-prompt creates the agent and prints the instructions with its token, for pasting into the agent", async () => {
  const r = await fleet("agent", "add", "pasted-agent", "--print-prompt");
  expect(r.code).toBe(0);
  const token = /fleet join \S+ (\S+) --name pasted-agent/.exec(r.out)?.[1];
  expect(token).toBeTruthy();
  expect(store.agentByToken(token!)?.name).toBe("pasted-agent");
  expect(existsSync(`${home}/agents/pasted-agent.json`)).toBe(false);
}, 20000);

// ---------- the installer that puts `fleet` on the PATH ----------

test("the install script installs a fleet launcher from this hub, and is valid shell", async () => {
  const script = installScript("http://hub:8787");
  expect(script).toContain("HUB='http://hub:8787'");
  expect(script).toContain('"$HUB/fleet.ts"');
  const syntax = Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script) });
  expect(syntax.exitCode).toBe(0);
});

test("running the install script in a clean home gives a working `fleet` command, and re-running it is harmless", async () => {
  const fakeHome = mkdtempSync(`${tmpdir()}/fleet-install-home-`);
  const script = installScript(url);
  // async, because the hub under test lives in this process: a blocking spawn would starve it
  const run = async () => {
    const p = Bun.spawn(["sh", "-c", script], { env: { PATH: `${process.execPath.replace(/\/[^/]+$/, "")}:/usr/bin:/bin`, HOME: fakeHome }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    return { stdout, stderr, exitCode };
  };
  const first = await run();
  expect(first.exitCode).toBe(0);
  const out = first.stdout;
  expect(out).toMatch(/fleet login/);
  expect(out).toContain('export PATH="$HOME/.local/bin:$PATH"');   // printed literally, not expanded
  expect(existsSync(`${fakeHome}/.fleet/fleet.ts`)).toBe(true);
  expect(statSync(`${fakeHome}/.local/bin/fleet`).mode & 0o111).not.toBe(0);
  const usage = Bun.spawnSync([`${fakeHome}/.local/bin/fleet`], { env: { HOME: fakeHome, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  expect(usage.stdout.toString()).toMatch(/fleet: manage fleet agents/);   // works without bun on the PATH: the launcher holds bun's full path
  expect((await run()).exitCode).toBe(0);
}, 30000);

test("the install script says what is missing when bun is not installed", () => {
  const r = Bun.spawnSync(["sh", "-c", installScript("http://hub:8787")], { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home" }, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toMatch(/bun/i);
});

// ---------- an agent that already exists on the hub, whose token nobody has ----------

test("reconnect issues a new token for an existing agent and sets it up here, keeping the agent's identity", async () => {
  const old = store.addAgent({ name: "old-agent", owner: "alper", device: "laptop", skills: [] });
  const r = await fleet("agent", "reconnect", "old-agent", "--harness", "claude", "--dir", work, "--no-start");
  expect(r.code).toBe(0);
  const cfg = JSON.parse(readFileSync(`${home}/agents/old-agent.json`, "utf8"));
  expect(store.agentByToken(cfg.token)?.id).toBe(old.id);    // same agent on the hub, so its tasks and chats are still its own
  expect(store.agentByToken(old.token)).toBeNull();          // the token nobody had no longer works
  expect(store.listAgents().filter((a) => a.name === "old-agent").length).toBe(1);
}, 30000);

test("reconnect refuses a name the hub does not know, and creates nothing", async () => {
  const before = store.listAgents().length;
  const r = await fleet("agent", "reconnect", "never-existed", "--harness", "claude", "--dir", work, "--no-start");
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/no active agent/i);
  expect(store.listAgents().length).toBe(before);
});

test("reconnect with --print-prompt hands the new token to an agent that will set itself up", async () => {
  store.addAgent({ name: "old-two", owner: "alper", device: "mac", skills: [] });
  const r = await fleet("agent", "reconnect", "old-two", "--print-prompt");
  expect(r.code).toBe(0);
  const token = /fleet join \S+ (\S+) --name old-two/.exec(r.out)?.[1];
  expect(store.agentByToken(token!)?.name).toBe("old-two");
}, 20000);

// ---------- workspaces from the command line ----------

test("workspace add creates one, workspace ls lists them with their agents, and duplicates are refused", async () => {
  const add = await fleet("workspace", "add", "han-test");
  expect(add.code).toBe(0);
  expect(store.listWorkspaces().map((w) => w.name)).toContain("han-test");
  const again = await fleet("workspace", "add", "HAN-TEST");
  expect(again.code).not.toBe(0);
  expect(again.out).toMatch(/already exists/);
  const ls = await fleet("workspace", "ls");
  expect(ls.out).toMatch(/Default/);
  expect(ls.out).toMatch(/han-test/);
}, 30000);

test("agent add --workspace puts the agent in that workspace; an unknown workspace is refused before anything is created", async () => {
  const before = store.listAgents().length;
  const bad = await fleet("agent", "add", "ws-lost", "--harness", "claude", "--dir", work, "--workspace", "no-such-place", "--no-start");
  expect(bad.code).not.toBe(0);
  expect(bad.out).toMatch(/no workspace/i);
  expect(store.listAgents().length).toBe(before);
  const ok = await fleet("agent", "add", "ws-agent", "--harness", "claude", "--dir", work, "--workspace", "han-test", "--no-start");
  expect(ok.code).toBe(0);
  expect(store.workspaceByName("han-test")!.id).toBe(store.listAgents().find((a) => a.name === "ws-agent")!.workspaceId);
  expect((await fleet("workspace", "ls")).out).toMatch(/han-test.*ws-agent/s);
}, 30000);

test("agent move changes an idle agent's workspace", async () => {
  const r = await fleet("agent", "move", "ws-agent", "Default");
  expect(r.code).toBe(0);
  expect(store.listAgents().find((a) => a.name === "ws-agent")!.workspaceId).toBe("default");
}, 20000);

// ---------- importing an existing session ----------

test("a session id is checked against the harness before anything is created", () => {
  expect(validateSession("claude", "bf26ea24-5be5-4119-954f-199f787baf9d")).toBeNull();
  expect(validateSession("claude", "not-a-uuid")).toMatch(/uuid/i);
  expect(validateSession("opencode", "ses_fleet52f7f1b3b6edd1fed48d")).toBeNull();
  expect(validateSession("opencode", "bf26ea24-5be5-4119-954f-199f787baf9d")).toMatch(/ses_/);
  expect(validateSession("prime", "anything")).toMatch(/prime-agent/);
  expect(validateSession("custom", "any-id-the-tool-understands")).toBeNull();
  expect(validateSession("custom", "  ")).toMatch(/empty/i);
});

test("Claude keeps a folder's sessions in a folder named after the path, and the sessions can be listed with a hint of what they were about", () => {
  expect(claudeProjectDir("/Users/me/coding/han-test", "/h")).toBe("/h/.claude/projects/-Users-me-coding-han-test");
  expect(claudeProjectDir("/Users/me/my.app_v2", "/h")).toBe("/h/.claude/projects/-Users-me-my-app-v2");
  const h = mkdtempSync(`${tmpdir()}/fleet-sess-`);
  const dir = claudeProjectDir("/work/demo", h);
  mkdirSync(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  writeFileSync(`${dir}/11111111-1111-4111-8111-111111111111.jsonl`, line({ type: "summary" }) + line({ type: "user", message: { role: "user", content: "Fix the booking date bug in kapi-demo" } }));
  writeFileSync(`${dir}/22222222-2222-4222-8222-222222222222.jsonl`, line({ type: "user", message: { role: "user", content: [{ type: "text", text: "Modernize the panel" }] } }));
  writeFileSync(`${dir}/notes.txt`, "not a session");
  utimesSync(`${dir}/11111111-1111-4111-8111-111111111111.jsonl`, new Date(2026, 9, 1), new Date(2026, 9, 1));
  const list = listClaudeSessions("/work/demo", h);
  expect(list.map((s) => s.id)).toEqual(["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"]);   // newest first
  expect(list[0].preview).toBe("Modernize the panel");
  expect(list[1].preview).toBe("Fix the booking date bug in kapi-demo");
  expect(listClaudeSessions("/nowhere", h)).toEqual([]);
  // a session that began with the fleet's standard instructions shows what it was woken for, not the boilerplate
  writeFileSync(`${dir}/33333333-3333-4333-8333-333333333333.jsonl`, line({ type: "user", message: { role: "user", content: "You are an agent on a shared fleet. These are your instructions:\n\n# Joining the fleet\nlots of text\n\n---\nNow handle these items from the hub:\n- TASK KAPI-12 (project kapi): modernize the pilot ui" } }));
  expect(listClaudeSessions("/work/demo", h)[0].preview).toBe("- TASK KAPI-12 (project kapi): modernize the pilot ui");
});

test("agent add --session adopts an existing session; a bad id or a harness that cannot adopt is refused before anything is created", async () => {
  const before = store.listAgents().length;
  const bad = await fleet("agent", "add", "sess-bad", "--harness", "claude", "--dir", work, "--session", "nope", "--no-start");
  expect(bad.code).not.toBe(0);
  expect(bad.out).toMatch(/uuid/i);
  const prime = await fleet("agent", "add", "sess-prime", "--harness", "prime-agent", "--model", "m", "--permissions", "open", "--dir", work, "--session", "x", "--no-start");
  expect(prime.code).not.toBe(0);
  expect(store.listAgents().length).toBe(before);
  const id = "bf26ea24-5be5-4119-954f-199f787baf9d";
  const ok = await fleet("agent", "add", "sess-ok", "--harness", "claude", "--dir", work, "--session", id, "--no-start");
  expect(ok.code).toBe(0);
  expect(ok.out).toContain(id);
  expect(JSON.parse(readFileSync(`${home}/agents/sess-ok.json`, "utf8")).session).toBe(id);
}, 30000);

test("reconnect --session brings an existing agent back onto an old conversation", async () => {
  store.addAgent({ name: "sess-old", owner: "alper", device: "laptop", skills: [] });
  const id = "11111111-1111-4111-8111-111111111111";
  const r = await fleet("agent", "reconnect", "sess-old", "--harness", "claude", "--dir", work, "--session", id, "--no-start");
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(`${home}/agents/sess-old.json`, "utf8")).session).toBe(id);
}, 30000);

test("fleet sessions lists what can be imported, with a hint of each conversation and how to adopt it", async () => {
  const r = await fleet("sessions", "--dir", work);
  expect(r.code).toBe(0);
  expect(r.out).toContain("bf26ea24-5be5-4119-954f-199f787baf9d");
  expect(r.out).toContain("hello from bf26");
  expect(r.out).toMatch(/--session <id>/);
}, 20000);

// ---------- Codex ----------

test("codex permissions map to its sandbox, and open is the only way to skip the sandbox", () => {
  expect(normalizeHarness("codex")).toBe("codex");
  expect(extraArgsFor("codex", "safe")).toEqual(["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"']);
  expect(extraArgsFor("codex", "edits")).toEqual(["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"']);
  expect(extraArgsFor("codex", "open")).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  expect(permissionNote("codex", "open")).toMatch(/without (a )?sandbox|anything/i);
});

test("codex keeps its sessions by date, and the ones started in a folder can be listed", () => {
  const h = mkdtempSync(`${tmpdir()}/fleet-codex-home-`);
  const day = `${h}/.codex/sessions/2026/10/31`;
  mkdirSync(day, { recursive: true });
  const meta = (id: string, cwd: string) => JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp: "2026-10-31T18:12:17.133Z" } }) + "\n";
  const said = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the date bug" }] } }) + "\n";
  writeFileSync(`${day}/rollout-2026-10-31T21-12-17-01a19329-9069-7dd1-b5a1-ee5af7a024fd.jsonl`, meta("01a19329-9069-7dd1-b5a1-ee5af7a024fd", "/work/demo") + said);
  writeFileSync(`${day}/rollout-2026-10-31T22-00-00-01a1932a-0000-7000-8000-000000000001.jsonl`, meta("01a1932a-0000-7000-8000-000000000001", "/elsewhere"));
  const list = listCodexSessions("/work/demo", h);
  expect(list.map((s) => s.id)).toEqual(["01a19329-9069-7dd1-b5a1-ee5af7a024fd"]);
  expect(list[0].preview).toBe("Fix the date bug");
  expect(listCodexSessions("/nothing", h)).toEqual([]);
});

// ---------- model lists a device can offer ----------

test("opencode's model list is one provider/model per line; anything else in the output is ignored", () => {
  expect(parseOpencodeModels("openai/gpt-5.5\nopencode-go/deepseek-v4.1-flash\n\nWarning: something\n")).toEqual(["openai/gpt-5.5", "opencode-go/deepseek-v4.1-flash"]);
  // opencode lists hosted catalogues whose model id has more slashes and capitals: they are real models, not noise
  expect(parseOpencodeModels("wandb/openai/gpt-oss-120b\nwandb/Qwen/Qwen3.8-27B\n")).toEqual(["wandb/openai/gpt-oss-120b", "wandb/Qwen/Qwen3.8-27B"]);
  expect(parseOpencodeModels("")).toEqual([]);
});

test("prime-agent's table is read for the chosen provider only", () => {
  const table = "provider     model                         context  max-out\nopencode-go  deepseek-v4-flash             1M       384K\nopencode-go  glm-5.2                       1M       131K\nother        not-this-one                  1M       1K\n";
  expect(parsePrimeModels(table, "opencode-go")).toEqual(["deepseek-v4-flash", "glm-5.2"]);
});

test("codex's catalog yields the models it lists, in its own order, and survives rubbish", () => {
  const json = JSON.stringify({ models: [{ slug: "gpt-6-astra", visibility: "list" }, { slug: "codex-auto-review", visibility: "hide" }, { slug: "gpt-5.5", visibility: "list" }] });
  expect(parseCodexModels(json)).toEqual(["gpt-6-astra", "gpt-5.5"]);
  expect(parseCodexModels("not json")).toEqual([]);
});

test("agy models prints one slug per line, tab separated; its fetch note and any noise are not models", () => {
  // The exact shape agy 1.4.12 prints on stdout (the "Fetching available models..." note goes to stderr).
  const real = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
  expect(parseAgyModels(real)).toEqual(["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);
  // Notes, blank lines, a header, and a line with no display name are dropped; the slug is never rebuilt from the label.
  expect(parseAgyModels("Fetching available models...\n\nNAME  LABEL\ngemini-3.8-flash-high\n\tGemini 3.8 Flash (High)\n")).toEqual([]);
  // Colour codes are tolerated, and a slug listed twice is listed once.
  expect(parseAgyModels("\x1b[32mgemini-3.8-flash-high\x1b[0m\tGemini 3.8 Flash (High)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n")).toEqual(["gemini-3.8-flash-high"]);
  expect(parseAgyModels("")).toEqual([]);
});

test("agy's model list is discovered with `agy models`, and a failure says why without echoing its stderr", () => {
  const ok = discoverModels(new Set(["antigravity"]), (cmd) => cmd.join(" ") === "agy models"
    ? { stdout: "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n", stderr: "Fetching available models...\n", status: 0 }
    : { stdout: "", stderr: "", status: 127 }, { refresh: true, key: "agy-ok" });
  expect(ok.models.antigravity).toEqual(["gemini-3.8-flash-medium"]);
  expect(ok.info.antigravity.source).toBe("agy models");
  expect(ok.info.antigravity.error).toBeUndefined();

  const denied = discoverModels(new Set(["antigravity"]), () => ({ stdout: "", stderr: "sign in first: token sk-secret", status: 1 }), { refresh: true, key: "agy-bad" });
  expect(denied.models.antigravity).toEqual([]);
  expect(denied.info.antigravity.error).toMatch(/exited 1/);
  expect(denied.info.antigravity.error).not.toMatch(/sk-secret/);
});

test("antigravity does not need a model: with none, agy uses the model chosen in its own interface", async () => {
  const { harnessInfo } = await import("../shared/harnesses");
  expect(normalizeHarness("agy")).toBe("antigravity");
  expect(harnessInfo("antigravity").model).toBe("optional");
  // The join only refuses a harness whose model is required, so `fleet agent add --harness antigravity` works without --model.
  const src = readFileSync(new URL("../cli/fleet.ts", import.meta.url), "utf8");
  expect(src).toContain('if (harnessInfo(o.harness).model === "required" && !o.model)');
});

// ---------- device allow: helpful when the folder is not there ----------

test("allowing a folder that does not exist says so, offers to create it, and names the usual places that do exist", async () => {
  await fleet("device", "enroll", url, store.addDevice("allow-test").token);
  const missing = `${work}/not-there-yet`;
  const r = await fleet("device", "allow", missing);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/does not exist/i);
  expect(r.out).toContain("--create");
  const made = await fleet("device", "allow", missing, "--create");
  expect(made.code).toBe(0);
  expect(existsSync(missing)).toBe(true);
  expect((await fleet("device", "roots")).out).toContain("not-there-yet");
  const none = await fleet("device", "allow");
  expect(none.code).not.toBe(0);
  expect(none.out).toMatch(/Usage/);
  await fleet("device", "stop");
}, 40000);

test("joining again as an agent whose helper is already running replaces that helper, so the new token is the one in use", async () => {
  const add = await fleet("agent", "add", "restarter", "--harness", "custom", "--permissions", "open", "--dir", work, "--run-cmd", bot("new"), "--resume-cmd", bot("resume"));
  expect(add.code).toBe(0);
  const pidOf = () => Number(readFileSync(`${home}/run/restarter.pid`, "utf8"));
  const before = pidOf();
  const again = await fleet("agent", "reconnect", "restarter", "--harness", "custom", "--permissions", "open", "--dir", work, "--run-cmd", bot("new"), "--resume-cmd", bot("resume"));
  expect(again.code).toBe(0);
  const after = pidOf();
  expect(after).not.toBe(before);
  expect(() => process.kill(before, 0)).toThrow();               // the old helper is gone
  expect(() => process.kill(after, 0)).not.toThrow();            // the new one is running
  await fleet("stop", "restarter");
}, 90000);

// A copy of the part of `claude --help` that names the aliases --model takes. Claude Code has no command that lists models.
const CLAUDE_HELP = `Options:
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -n, --name <name>                     Set a display name for this session
                                        (shown in the prompt box, /resume
                                        picker, and terminal title)
`;

test("Claude's model aliases are read from the help it prints, not from a list kept here", () => {
  expect(parseClaudeModelAliases(CLAUDE_HELP)).toEqual(["fable", "opus", "sonnet"]);
  expect(parseClaudeModelAliases("no model option here")).toEqual([]);
  expect(parseClaudeModelAliases("  --model <model>   Model to use.\n")).toEqual([]);        // no alias named: say so instead of inventing one
});

// The SDK initialization answer: models[].value is all the fleet keeps. The account block is fixture noise and must not leak.
const CLAUDE_INIT_OK = [
  JSON.stringify({ type: "system", subtype: "init", account: { email: "person@example.com" } }),
  JSON.stringify({
    type: "control_response", request_id: "fleet-model-discovery",
    response: { subtype: "success", response: { models: [
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
      { value: "opus" }, { value: "claude-fable-5-1[1m]" }, { value: "sonnet" }, { value: "haiku" },
    ], account: { email: "person@example.com" } } },
  }),
].join("\n") + "\n";

test("Claude's account models come from the SDK initialization response, with no prompt and no inference", () => {
  let stdin = "";
  const found = discoverModels(new Set(["claude"]), (cmd, input) => {
    expect(cmd).toEqual(["claude", "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json"]);
    stdin = input ?? "";
    return CLAUDE_INIT_OK;
  }, { refresh: true, key: "claude-init-ok" });
  expect(found.models.claude).toEqual(["default", "opus", "claude-fable-5-1[1m]", "sonnet", "haiku"]);   // exact values, brackets kept
  expect(found.info.claude.source).toBe("Claude Code SDK initialization (available models)");
  expect(stdin).toBe('{"type":"control_request","request_id":"fleet-model-discovery","request":{"subtype":"initialize"}}\n');
  expect(JSON.stringify(found)).not.toContain("person@example.com");
  expect(JSON.stringify(found)).not.toContain("claude-opus-5-5");       // resolvedModel/displayName are not model choices
});

test("Claude init falls back to the tool's own aliases when the answer is malformed, unrelated, or a failure", () => {
  const cases: { why: string; run: (cmd: string[]) => string | { stdout: string; stderr: string; status: number | null } }[] = [
    { why: "malformed", run: (cmd) => cmd.includes("--input-format") ? "not json\n" : CLAUDE_HELP },
    { why: "unrelated", run: (cmd) => cmd.includes("--input-format")
      ? JSON.stringify({ type: "control_response", request_id: "someone-else", response: { subtype: "success", response: { models: [{ value: "not-ours" }] } } })
      : CLAUDE_HELP },
    { why: "failure", run: (cmd) => cmd.includes("--input-format") ? { stdout: "", stderr: "account detail sk-secret", status: 1 } : CLAUDE_HELP },
    { why: "error-response", run: (cmd) => cmd.includes("--input-format")
      ? JSON.stringify({ type: "control_response", request_id: "fleet-model-discovery", response: { subtype: "error", response: { models: [{ value: "not-ours" }] } } })
      : CLAUDE_HELP },
  ];
  for (const [i, c] of cases.entries()) {
    const found = discoverModels(new Set(["claude"]), c.run, { refresh: true, key: `claude-init-${i}` });
    expect(found.models.claude).toEqual(["fable", "opus", "sonnet"]);
    expect(found.info.claude.source).toContain("SDK initialization did not list models");
    expect(found.info.claude.source).toContain("claude --help");
    expect(JSON.stringify(found)).not.toContain("not-ours");
    expect(JSON.stringify(found)).not.toContain("sk-secret");
  }
});

test("each installed tool is asked for its models, and the answer says where it came from", () => {
  const asked: string[] = [];
  const run = (cmd: string[]) => {
    const line = cmd.join(" ");
    asked.push(line);
    if (line === "claude --help") return CLAUDE_HELP;
    if (line === "opencode models") return "openai/gpt-5.5\nopencode-go/glm-5.2\n";
    if (line === "prime-agent model list opencode-go") return { stdout: "", stderr: "provider model\nopencode-go glm-5.2 1M\n", status: 0 };   // its table is on stderr
    if (line === "codex debug models") return JSON.stringify({ models: [{ slug: "gpt-6-astra", visibility: "list" }, { slug: "hidden", visibility: "hide" }] });
    return { stdout: "", stderr: `unexpected command: ${line}`, status: 127 };
  };
  const found = discoverModels(new Set(["claude", "opencode", "prime", "codex"]), run, { refresh: true, key: "discover-all" });
  expect(found.models.claude).toEqual(["fable", "opus", "sonnet"]);
  expect(found.models.opencode).toEqual(["openai/gpt-5.5", "opencode-go/glm-5.2"]);
  expect(found.models.prime).toEqual(["glm-5.2"]);
  expect(found.models.codex).toEqual(["gpt-6-astra"]);
  expect(found.info.opencode).toMatchObject({ source: "opencode models", found: 2 });
  expect(found.info.codex).toMatchObject({ source: "codex debug models", found: 1 });
  expect(found.info.claude.source).toMatch(/claude --help/);
  expect(found.info.opencode.error).toBeUndefined();
  expect(asked).toContain("codex debug models");
});

test("a model list that fails or comes back empty says why, without repeating what the tool printed", () => {
  const run = (cmd: string[]) => {
    const line = cmd.join(" ");
    if (line === "claude --help" || line.startsWith("claude --print")) return { stdout: "", stderr: "claude: command failed", status: 2 };
    if (line === "opencode models") return { stdout: "openai/gpt-5.5\n", stderr: "Warning: token sk-secret-123 rejected\n", status: 1 };
    if (line === "prime-agent model list opencode-go") return { stdout: "", stderr: "", status: 0 };
    if (line === "codex debug models") return "not json";
    return "";
  };
  const found = discoverModels(new Set(["claude", "opencode", "prime", "codex"]), run, { refresh: true, key: "failures" });
  expect(found.models.opencode).toEqual([]);                    // a failed run's partial output is not trusted
  expect(found.info.opencode.error).toMatch(/opencode models exited 1/);
  expect(found.info.opencode.error).not.toMatch(/sk-secret|token/i);   // stderr may hold secrets: never repeat it
  expect(found.info.claude.error).toMatch(/exited 2/);
  expect(found.info.prime.error).toMatch(/printed no models/);
  expect(found.info.codex.error).toMatch(/did not print the catalog/);
  for (const id of ["claude", "opencode", "prime", "codex"]) expect(found.info[id].found).toBe(0);
});

test("a command that never finished is a failure, not an empty success", () => {
  const found = discoverModels(new Set(["opencode"]), () => ({ stdout: "openai/gpt-5.5\n", stderr: "", status: null }), { refresh: true, key: "timeout" });
  expect(found.models.opencode).toEqual([]);
  expect(found.info.opencode.error).toMatch(/did not finish/);
});

test("Hermes offers the configured default first, then only its configured provider's native ids", () => {
  const root = mkdtempSync(`${tmpdir()}/fleet-hermes-`);
  const config = `${root}/config.yaml`, python = `${root}/hermes-agent/venv/bin/python`;
  mkdirSync(`${root}/hermes-agent/venv/bin`, { recursive: true });
  writeFileSync(python, "#!/bin/sh\n");
  const run = (cmd: string[]) => {
    const line = cmd.join(" ");
    if (line === "hermes config get model --json") return JSON.stringify({ default: "anthropic/claude-opus-4.6", provider: "anthropic" });
    if (line === "hermes config path") return config;
    if (cmd[0] === python && cmd[2].includes("_PROVIDER_MODELS")) {
      expect(cmd[3]).toBe("anthropic");                                  // the configured provider, never every provider
      return JSON.stringify(["claude-opus-4.6", "claude-sonnet-4.6"]);
    }
    return { stdout: "", stderr: "", status: 127 };
  };
  const found = discoverHermesModels(run, { refresh: true, key: `hermes-${root}` });
  expect(found.models).toEqual(["anthropic/claude-opus-4.6", "claude-opus-4.6", "claude-sonnet-4.6"]);   // native ids stay as they are
  expect(found.info.source).toMatch(/provider anthropic/);
  expect(found.info.found).toBe(3);
  expect(found.info.error).toBeUndefined();
});

test("Hermes resolves its own auto provider, and falls back to the default alone when it cannot", () => {
  const root = mkdtempSync(`${tmpdir()}/fleet-hermes-auto-`);
  const config = `${root}/config.yaml`, python = `${root}/hermes-agent/venv/bin/python`;
  mkdirSync(`${root}/hermes-agent/venv/bin`, { recursive: true });
  writeFileSync(python, "#!/bin/sh\n");
  const runner = (resolved: string) => (cmd: string[]) => {
    const line = cmd.join(" ");
    if (line === "hermes config get model --json") return JSON.stringify({ default: "anthropic/claude-opus-4.6", provider: "auto" });
    if (line === "hermes config path") return config;
    if (cmd[0] === python && cmd[2].includes("detect_provider_for_model")) return JSON.stringify(resolved);
    if (cmd[0] === python && cmd[2].includes("_PROVIDER_MODELS")) return JSON.stringify(["claude-opus-4.6"]);
    return { stdout: "", stderr: "", status: 0 };
  };
  const ok = discoverHermesModels(runner("anthropic"), { refresh: true, key: "hermes-auto-ok" });
  expect(ok.models).toEqual(["anthropic/claude-opus-4.6", "claude-opus-4.6"]);
  expect(ok.info.source).toMatch(/provider anthropic/);
  const unknown = discoverHermesModels(runner("not a provider!"), { refresh: true, key: "hermes-auto-bad" });
  expect(unknown.models).toEqual(["anthropic/claude-opus-4.6"]);          // no invented ids
  expect(unknown.info.source).toMatch(/configured default only/);
  expect(unknown.info.source).toMatch(/auto/);
});

test("an unknown Hermes provider gets the default alone, and a failed config command says why without echoing stderr", () => {
  const root = mkdtempSync(`${tmpdir()}/fleet-hermes-unknown-`);
  const config = `${root}/config.yaml`, python = `${root}/hermes-agent/venv/bin/python`;
  mkdirSync(`${root}/hermes-agent/venv/bin`, { recursive: true });
  writeFileSync(python, "#!/bin/sh\n");
  const run = (cmd: string[]) => {
    const line = cmd.join(" ");
    if (line === "hermes config get model --json") return JSON.stringify({ default: "mystery/model-1", provider: "mystery" });
    if (line === "hermes config path") return config;
    if (cmd[0] === python && cmd[2].includes("_PROVIDER_MODELS")) return JSON.stringify([]);
    return { stdout: "", stderr: "", status: 0 };
  };
  const found = discoverHermesModels(run, { refresh: true, key: "hermes-unknown" });
  expect(found.models).toEqual(["mystery/model-1"]);
  expect(found.info.source).toMatch(/no offline catalog for provider mystery/);
  const broken = discoverHermesModels((cmd) => cmd[0] === "hermes" ? { stdout: "", stderr: "key sk-secret rejected", status: 1 } : "", { refresh: true, key: "hermes-broken" });
  expect(broken.models).toEqual([]);
  expect(broken.info.error).toMatch(/exited 1/);
  expect(broken.info.error).not.toMatch(/sk-secret/);
});

test("Codex keeps its two-turn self-check on every join, including from a device launch", () => {
  const src = readFileSync(new URL("../cli/fleet.ts", import.meta.url), "utf8");
  expect(src).toContain('o.harness === "custom" || o.harness === "codex" || harnessInfo(o.harness).unverified');
});

test("fleet update restarts a running device daemon, so model discovery runs with the new code", () => {
  const src = readFileSync(new URL("../cli/fleet.ts", import.meta.url), "utf8");
  expect(src).toContain("if (runningPid(DEVICE)) { await stopAgent(DEVICE); startAgent(DEVICE); console.log(\"Restarted the device daemon");
});

test("the model cache is keyed by the installed tools and their programs, and can be refreshed at once", () => {
  const base = 10_000_000, calls: string[] = [];
  const run = (cmd: string[]) => {
    calls.push(cmd.join(" "));
    if (cmd[0] === "opencode") return "openai/gpt-5.5\n";
    if (cmd[0] === "codex") return JSON.stringify({ models: [{ slug: "gpt-6-astra", visibility: "list" }] });
    return CLAUDE_HELP;
  };
  const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
  discoverModels(new Set(["opencode"]), run, { refresh: true, now: base, key: "tool-a" });
  expect(count("opencode")).toBe(1);
  discoverModels(new Set(["opencode"]), run, { now: base + 1_000, key: "tool-a" });         // same tools, same programs: answered from memory
  expect(count("opencode")).toBe(1);
  discoverModels(new Set(["opencode", "codex"]), run, { now: base + 2_000, key: "tool-a" }); // a tool was installed: ask again at once
  expect(count("opencode")).toBe(2);
  expect(count("codex")).toBe(1);
  discoverModels(new Set(["opencode", "codex"]), run, { now: base + 3_000, key: "tool-b" }); // the program changed (upgrade): ask again
  expect(count("opencode")).toBe(3);
  discoverModels(new Set(["opencode", "codex"]), run, { now: base + 4_000, key: "tool-b", refresh: true });
  expect(count("opencode")).toBe(4);
  discoverModels(new Set(["opencode", "codex"]), run, { now: base + 4_000 + MODEL_CACHE_MS + 1, key: "tool-b" });   // the list goes stale after ten minutes
  expect(count("opencode")).toBe(5);
});

test("a failed model list is retried after a minute, not kept for ten", () => {
  const base = 20_000_000, calls: string[] = [];
  const run = (cmd: string[]) => { calls.push(cmd.join(" ")); return { stdout: "", stderr: "not signed in", status: 1 }; };
  discoverModels(new Set(["opencode"]), run, { refresh: true, now: base, key: "error-retry" });
  discoverModels(new Set(["opencode"]), run, { now: base + 30_000, key: "error-retry" });
  expect(calls.length).toBe(1);                                 // still inside the shorter failure window
  discoverModels(new Set(["opencode"]), run, { now: base + MODEL_ERROR_CACHE_MS + 1, key: "error-retry" });
  expect(calls.length).toBe(2);                                 // the person has had a minute to fix it
});

test("collectModels still returns just the lists, for callers that do not show the explanation", () => {
  const found = collectModels(new Set(["opencode"]), () => "openai/gpt-5.5\n", { refresh: true, key: "collect-only" });
  expect(found).toEqual({ opencode: ["openai/gpt-5.5"] });
});
