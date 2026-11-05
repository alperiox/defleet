// Actual sleep-300 harness smoke, using in-process hub requests (no listener, no inference spend).
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { processPending, runTurn, type HelperConfig, type HelperIO, type Interruption } from "../helper/fleet-helper";
const dir = mkdtempSync(join(tmpdir(), "fleet-stop-smoke-"));
const { app, hub, store } = createApp(":memory:", "fixture-human", { hubOwner: "owner" });
const c = store.addAgent({ name: "sleep-worker", owner: "owner", device: "local smoke", skills: [] }); const agent = store.agentById(c.id)!;
const harness = join(dir, "harness.sh"), marker = join(dir, "started"), childFile = join(dir, "child");
await Bun.write(harness, `if [ -f '${marker}' ]; then
  printf '%s' "$1" > '${dir}/session'
  printf '%s' "$2" > '${dir}/prompt'
else
  touch '${marker}'
  sleep 300 &
  echo $! > '${childFile}'
  wait
fi
`);
const config: HelperConfig = { hubUrl: "http://fixture", token: "fixture", harness: "custom", workdir: dir, sessionId: "smoke-same-session", model: "", extraArgs: [], quarantineSessionId: "none", sandboxDir: dir, untrusted: "refuse", provider: "", stateDir: dir, runCmd: `/bin/sh '${harness}' {session} {prompt}`, resumeCmd: `/bin/sh '${harness}' {session} {prompt}` };
let started = false, checkpoint: Interruption | null = null, runs = 0, firstPid = 0;
const logs: string[] = [];
const io: HelperIO = {
 pull: async (ack) => hub.pull(agent, ack), skills: async () => "",
 onStop: (fn) => hub.onAgentStop(agent.id, fn), activity: async (state, note, turn) => hub.setActivity(agent, state, note, turn),
 state: { started: () => started, markStarted: () => { started = true; }, interruption: () => checkpoint, setInterruption: (v) => { checkpoint = v; } },
 run: async (cmd, signal) => { runs++; return runTurn(cmd, signal, { quiet: true, onSpawn: (pid) => { if (runs === 1) firstPid = pid; } }); },
 log: (line) => logs.push(line),
};
try {
 hub.humanDm(agent.name, "Original task for the sleeping harness");
 const running = processPending(config, io);
 const deadline = Date.now() + 3000; while (!existsSync(childFile) && Date.now() < deadline) await Bun.sleep(10);
 if (!existsSync(childFile)) throw new Error("sleep child did not start");
 const child = Number(readFileSync(childFile, "utf8"));
 const response = await app.request(`/api/agents/${agent.name}/stop`, { method: "POST", headers: { authorization: "Bearer fixture-human", "content-type": "application/json" }, body: JSON.stringify({ text: "What happened before I stopped you?" }) });
 const result: any = await response.json(); if (!result.stopped) throw new Error("stop not signaled");
 if (await running !== "ok") throw new Error("drain failed");
 const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
 for (let i = 0; i < 100 && !gone(child); i++) await Bun.sleep(10);
 const prompt = readFileSync(join(dir, "prompt"), "utf8");
 if (!gone(firstPid) || !gone(child) || runs !== 2 || !prompt.includes("Your previous turn was interrupted by the human") || !prompt.includes("What happened before I stopped you?") || readFileSync(join(dir, "session"), "utf8") !== config.sessionId || hub.pull(agent).items.length) throw new Error("smoke proof failed");
 console.log(JSON.stringify({ harness: "real /bin/sh with sleep 300 child", parentPid: firstPid, childPid: child, processGroupGone: true, runs, sameSession: config.sessionId, interruptionNote: true, newMessageReceived: true, stoppedItemsNotReplayed: true, logs }, null, 2));
} finally { if (firstPid) { try { process.kill(-firstPid, "SIGKILL"); } catch {} } store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
