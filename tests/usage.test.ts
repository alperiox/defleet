import { test, expect, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import {
  parseClaudeUsage, parseAgyUsage, parseCodexRateLimits, parseOpencodeStats, collectUsage,
  USAGE_CACHE_MS, USAGE_CMD_MS, USAGE_TOTAL_MS, type UsageRunner,
} from "../cli/usage";

// The fixtures are real outputs, captured from the installed tools on 2026-11-03.

const CLAUDE_RESULT = `You are currently using your subscription to power your Claude Code usage

Current session: 8% used · resets Nov 4 at 1am (Europe/Istanbul)
Current week (all models): 4% used · resets Nov 9 at 6pm (Europe/Istanbul)
Current week (Fable): 0% used · resets Nov 9 at 6pm (Europe/Istanbul)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 549 requests · 26 sessions
  66% of your usage was at >150k context
  Top skills: /superpowers:test-driven-development 6%, /dataviz 3%
`;

/** `claude -p /usage --output-format json`: the text above sits in `result`, and the call costs no inference. */
const CLAUDE_JSON = JSON.stringify({
  is_error: false, duration_api_ms: 0, num_turns: 0, stop_reason: null, session_id: "01f57737-7e86-4314-8f05-a269559f4f23",
  total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [],
  subtype: "success", result: CLAUDE_RESULT,
});

const AGY_JSON = JSON.stringify({
  conversation_id: "", status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-10T13:18:17Z\n", duration_seconds: 0, num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: { name: "usage", data: {
    description: "Within each group, models share a weekly limit and a 5-hour limit.",
    groups: [
      { name: "Gemini Models", description: "Models within this group: Gemini Flash, Gemini Pro", buckets: [
        { id: "gemini-weekly", name: "Weekly Limit Remaining", description: "You have used some of your weekly limit, it will fully refresh in 6 days, 18 hours.", window: "weekly", remaining_fraction: 0.9841041564941406, reset_time: "2026-11-10T13:18:17Z" },
        { id: "gemini-5h", name: "Five Hour Limit Remaining", description: "You have used some of your 5-hour limit, it will fully refresh in 4 hours, 13 minutes.", window: "5h", remaining_fraction: 0.9631656408309937, reset_time: "2026-11-03T23:18:17Z" },
      ] },
      { name: "Claude and GPT models", description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS", buckets: [
        { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-10T19:05:08Z" },
        { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-04T00:05:08Z" },
      ] },
    ],
  } },
});

/** One line of a codex rollout file: the rate limits ride along on a token_count event. */
const CODEX_LINE = `{"timestamp":"2026-11-03T18:30:59.436Z","ordinal":18,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":17777,"total_tokens":17885}},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":6.0,"window_minutes":10080,"resets_at":1794003927},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"prolite"}}}`;
/** 1794003927 epoch SECONDS is 2026-11-06T22:25:27Z: a reading taken before it is still current. */
const CODEX_RESETS_MS = 1794003927 * 1000;

const OPENCODE_STATS = `opencode stats · 2026 so far · all projects

activity
   Jan  Feb Mar Apr  May Jun Jul  Aug Sep Oct  Nov
Mo  ··································░·▒█·····░
Su  ····································▒·······

   less ·░▒▓█ more

18 sessions · 29 subagents
219 prompts · 2.7k steps · 312.7m tokens
97.8% tool success · 18 active days · best streak 5 days

opencode.ai
`;

const NOW = Date.parse("2026-11-03T20:00:00Z");

// The files that drive the real device daemon switch measuring off for their own runs. This one injects its runner,
// so it must measure: the flag is cleared before every test here, whatever a neighbouring file left behind.
beforeEach(() => { delete process.env.FLEET_USAGE; });

// ---- claude ----

test("claude: every `Current` line becomes a window, and its reset time is resolved in the timezone it names", () => {
  const r = parseClaudeUsage(CLAUDE_RESULT, NOW);
  expect(r.error).toBeUndefined();
  expect(r.windows).toEqual([
    { label: "session", window: "session", usedFraction: 0.08, resetsAt: Date.parse("2026-11-03T22:00:00Z") },
    { label: "week (all models)", window: "weekly", usedFraction: 0.04, resetsAt: Date.parse("2026-11-09T15:00:00Z") },
    { label: "week (Fable)", window: "weekly", usedFraction: 0, resetsAt: Date.parse("2026-11-09T15:00:00Z") },
  ]);
  expect(r.source).toBe("claude -p /usage");
  expect(r.observedAt).toBe(NOW);
  expect(r.totals).toBeUndefined();
});

test("claude: the year is not printed, so the next occurrence of that date and time is used", () => {
  // A reset that has already happened this year is next year's.
  const late = parseClaudeUsage("Current session: 5% used · resets Nov 4 at 1am (Europe/Istanbul)", Date.parse("2026-11-03T23:30:00Z"));
  expect(late.windows[0].resetsAt).toBe(Date.parse("2027-11-03T22:00:00Z"));
  // And one written just before new year rolls into the next one.
  const rollover = parseClaudeUsage("Current week (all models): 9% used · resets Jan 2 at 5pm (Europe/Istanbul)", Date.parse("2026-12-30T00:00:00Z"));
  expect(rollover.windows[0].resetsAt).toBe(Date.parse("2027-01-02T14:00:00Z"));
});

test("claude: the timezone in the line is used, not the device's own", () => {
  const ny = parseClaudeUsage("Current session: 3% used · resets Nov 4 at 1am (America/New_York)", NOW);
  expect(ny.windows[0].resetsAt).toBe(Date.parse("2026-11-04T06:00:00Z"));      // EST, a week after DST ended
  const ist = parseClaudeUsage("Current session: 3% used · resets Nov 4 at 1am (Europe/Istanbul)", NOW);
  expect(ist.windows[0].resetsAt).toBe(Date.parse("2026-11-03T22:00:00Z"));
});

test("claude: times are read as printed (12am is midnight, 12pm is noon) and percentages are not rounded", () => {
  const midnight = parseClaudeUsage("Current session: 0.5% used · resets Nov 4 at 12:59am (Europe/Istanbul)", NOW);
  expect(midnight.windows[0]).toEqual({ label: "session", window: "session", usedFraction: 0.005, resetsAt: Date.parse("2026-11-03T21:59:00Z") });
  const noon = parseClaudeUsage("Current week (all models): 4.5% used · resets Nov 9 at 12pm (Europe/Istanbul)", NOW);
  expect(noon.windows[0].usedFraction).toBe(0.045);
  expect(noon.windows[0].resetsAt).toBe(Date.parse("2026-11-09T09:00:00Z"));
  // "week" (not "session") is a weekly window; anything else the tool prints is "other" but still shown.
  expect(parseClaudeUsage("Current 5 hour block: 1% used · resets Nov 4 at 1am (Europe/Istanbul)", NOW).windows[0].window).toBe("other");
});

test("claude: output with no line it can read is an error, never a guess", () => {
  for (const text of [
    "You are currently using your subscription to power your Claude Code usage",
    "Current session: 5% used",                                              // no reset time: a truncated format is not guessed at
    "Current session: 5% used · resets someday (Europe/Istanbul)",
    "error: you are not signed in",
  ]) {
    const r = parseClaudeUsage(text, NOW);
    expect(r.windows).toEqual([]);
    expect(r.error).toBe("unrecognised /usage output");
  }
});

test("claude: empty output reports 'no output from claude /usage'", () => {
  for (const text of ["", "   ", "\n\n"]) {
    const r = parseClaudeUsage(text, NOW);
    expect(r.windows).toEqual([]);
    expect(r.error).toBe("no output from claude /usage");
  }
});

test("claude: Mac Claude Code 2.1.224 output reports session cost specific reason", () => {
  const macOutput = `Total cost:            $0.0000
Total duration (API):  0s
Total duration (wall): 1s
Total code changes:    0 lines added, 0 lines removed
Usage:                 0 input, 0 output, 0 cache read, 0 cache write`;
  const r = parseClaudeUsage(macOutput, NOW);
  expect(r.windows).toEqual([]);
  expect(r.error).toBe("claude /usage reports session cost, not subscription limits");
});

test("claude: one unreadable line does not throw away the ones that did parse", () => {
  const r = parseClaudeUsage("Current session: 5% used · resets Nov 4 at 1am (Europe/Istanbul)\nCurrent week (all models): 4% used · resets November the ninth", NOW);
  expect(r.windows.map((w) => w.label)).toEqual(["session"]);
  expect(r.error).toBeUndefined();
});

test("claude: a line whose timezone this machine does not know keeps the reading with no reset time", () => {
  const r = parseClaudeUsage("Current week (all models): 4% used · resets Nov 9 at 6pm (Mars/Olympus)", NOW);
  expect(r.windows).toEqual([{ label: "week (all models)", window: "weekly", usedFraction: 0.04, resetsAt: null }]);
  expect(r.error).toBeUndefined();
});

// ---- antigravity ----

test("agy: each bucket of each group becomes one window, used = 1 - remaining", () => {
  const r = parseAgyUsage(AGY_JSON, NOW);
  expect(r.error).toBeUndefined();
  expect(r.source).toBe("agy -p /usage");
  expect(r.observedAt).toBe(NOW);
  expect(r.windows.map((w) => [w.label, w.window, w.resetsAt])).toEqual([
    ["Gemini Models · Weekly", "weekly", Date.parse("2026-11-10T13:18:17Z")],
    ["Gemini Models · Five Hour", "5h", Date.parse("2026-11-03T23:18:17Z")],
    ["Claude and GPT models · Weekly", "weekly", Date.parse("2026-11-10T19:05:08Z")],
    ["Claude and GPT models · Five Hour", "5h", Date.parse("2026-11-04T00:05:08Z")],
  ]);
  expect(r.windows[0].usedFraction).toBeCloseTo(1 - 0.9841041564941406, 10);
  expect(r.windows[2].usedFraction).toBe(0);
});

test("agy: an unknown window name is kept as other, and a missing reset time is null", () => {
  const r = parseAgyUsage(JSON.stringify({ status: "SUCCESS", command: { data: { groups: [{ name: "G", buckets: [{ name: "Monthly", window: "monthly", remaining_fraction: 0.25 }] }] } } }), NOW);
  expect(r.windows).toEqual([{ label: "G · Monthly", window: "other", usedFraction: 0.75, resetsAt: null }]);
});

test("agy: a failed run or unreadable JSON is an error with no windows, not an empty reading", () => {
  for (const text of ["not json at all", "{}", JSON.stringify({ status: "SUCCESS" }), JSON.stringify({ status: "SUCCESS", command: { data: { groups: [] } } })]) {
    const r = parseAgyUsage(text, NOW);
    expect(r.windows).toEqual([]);
    expect(r.error).toBeTruthy();
  }
  const failed = parseAgyUsage(JSON.stringify({ status: "ERROR", error: "not signed in" }), NOW);
  expect(failed.windows).toEqual([]);
  expect(failed.error).toMatch(/agy reported status ERROR/);
});

test("agy: signed-out output reports 'not signed in to Antigravity'", () => {
  const signedOut = parseAgyUsage(JSON.stringify({
    conversation_id: "",
    status: "ERROR",
    response: "",
    error: "authentication failed or timed out",
    duration_seconds: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    finished_reason: "error",
  }), NOW);
  expect(signedOut.windows).toEqual([]);
  expect(signedOut.error).toBe("not signed in to Antigravity");
});

// ---- codex ----

test("codex: the primary window is weekly here, and resets_at is epoch seconds turned into ms", () => {
  const mtime = Date.parse("2026-11-03T18:31:00Z");
  const r = parseCodexRateLimits(CODEX_LINE, mtime, CODEX_RESETS_MS - 3600_000);
  expect(r.error).toBeUndefined();
  expect(r.windows).toEqual([{ label: "Week", window: "weekly", usedFraction: 0.06, resetsAt: CODEX_RESETS_MS }]);
  expect(r.source).toBe("codex session files");
  expect(r.observedAt).toBe(mtime);                       // when the reading was written, not when it was read
});

test("codex: a 300 minute window is 5h, an unknown window length is other and keeps its minutes", () => {
  const line = (primary: object, secondary: object | null) => JSON.stringify({ payload: { rate_limits: { primary, secondary } } });
  const both = parseCodexRateLimits(line({ used_percent: 12, window_minutes: 300, resets_at: 1794003927 }, { used_percent: 50, window_minutes: 10080, resets_at: 1794003927 }), 1, 0);
  expect(both.windows.map((w) => [w.window, w.label, w.usedFraction])).toEqual([["5h", "5 hour", 0.12], ["weekly", "Week", 0.5]]);
  const other = parseCodexRateLimits(line({ used_percent: 1, window_minutes: 1440, resets_at: 1794003927 }, null), 1, 0);
  expect(other.windows).toEqual([{ label: "1440 min", window: "other", usedFraction: 0.01, resetsAt: CODEX_RESETS_MS }]);
});

test("codex: a reading from before its reset is stale, and says so instead of showing a number", () => {
  const r = parseCodexRateLimits(CODEX_LINE, Date.parse("2026-11-03T18:31:00Z"), CODEX_RESETS_MS + 1);
  expect(r.windows).toEqual([]);
  expect(r.error).toBe("last reading is from before the window reset");
});

test("codex: an unreadable line is an error, and a line with no window names nothing", () => {
  for (const [text, why] of [["{not json", /could not be read/], [JSON.stringify({ payload: { rate_limits: { primary: null, secondary: null } } }), /names no window/]] as const) {
    const r = parseCodexRateLimits(text, 1, 0);
    expect(r.windows).toEqual([]);
    expect(r.error).toMatch(why);
  }
});

// ---- opencode ----

test("opencode: the totals line becomes numbers, with no windows and a note about the plan limit", () => {
  const r = parseOpencodeStats(OPENCODE_STATS, NOW);
  expect(r.error).toBeUndefined();
  expect(r.windows).toEqual([]);
  expect(r.source).toBe("opencode stats");
  expect(r.observedAt).toBe(NOW);
  expect(r.totals).toEqual({ sessions: 18, prompts: 219, tokens: 312_700_000, note: "Plan limit is only on the OpenCode Go dashboard" });
});

test("opencode: k, m and b are thousands, millions and billions, and a line with no totals is an error", () => {
  const r = parseOpencodeStats("1.5k sessions · 2b tokens · 900 prompts", NOW);
  expect(r.totals).toMatchObject({ sessions: 1500, tokens: 2_000_000_000, prompts: 900 });
  const none = parseOpencodeStats("opencode stats · 2026 so far · all projects\n\n   less ·░▒▓█ more\n", NOW);
  expect(none.totals).toBeUndefined();
  expect(none.error).toBeTruthy();
});

// ---- the collector ----

const runOf = (handlers: Record<string, (opts?: { cwd?: string; timeoutMs?: number }) => unknown>) => {
  const calls: { cmd: string[]; opts?: { cwd?: string; timeoutMs?: number } }[] = [];
  const run: UsageRunner = (cmd, opts) => {
    calls.push({ cmd, opts });
    const handler = handlers[cmd.join(" ")];
    if (!handler) return { stdout: "", stderr: "no fixture", status: 1 };
    return handler(opts) as any;
  };
  return { run, calls };
};

const ok = (stdout: string) => ({ stdout, stderr: "", status: 0 });
const codexHomeWith = (line: string | null, mtimeMs = Date.parse("2026-11-03T18:31:00Z")) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-codex-"));
  if (line === null) return home;
  const dir = join(home, ".codex", "sessions", "2026", "11", "03");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-2026-11-03T21-30-51-01a1a2ad-a4a5-7291-9054-476f3e8844e6.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session_meta" })}\n${line}\n`);
  const secs = mtimeMs / 1000;
  utimesSync(file, secs, secs);
  return home;
};
const HANDLERS = {
  "claude -p /usage --output-format json": () => ok(CLAUDE_JSON),
  "agy -p /usage --output-format json": () => ok(AGY_JSON),
  "opencode stats": () => ok(OPENCODE_STATS),
};

test("the collector asks each installed tool in its own argv array, claude in a fresh temp directory that it removes", () => {
  const { run, calls } = runOf(HANDLERS);
  const home = codexHomeWith(CODEX_LINE);
  const usage = collectUsage(new Set(["claude", "codex", "antigravity", "opencode"]), run, { now: NOW, codexHome: home, refresh: true });
  expect(Object.keys(usage).sort()).toEqual(["antigravity", "claude", "codex", "opencode"]);
  const claude = calls.find((c) => c.cmd[0] === "claude")!;
  expect(claude.cmd).toEqual(["claude", "-p", "/usage", "--output-format", "json"]);     // argv, never a shell string
  expect(claude.opts!.cwd!.startsWith(tmpdir())).toBe(true);
  expect(existsSync(claude.opts!.cwd!)).toBe(false);                                     // the temp directory is gone afterwards
  expect(claude.opts!.timeoutMs).toBe(USAGE_CMD_MS);
  expect(calls.map((c) => c.cmd)).toEqual([
    ["claude", "-p", "/usage", "--output-format", "json"],
    ["agy", "-p", "/usage", "--output-format", "json"],
    ["opencode", "stats"],
  ]);
  expect(usage.claude.windows.length).toBe(3);
  expect(usage.antigravity.windows.length).toBe(4);
  expect(usage.codex.windows[0]).toMatchObject({ window: "weekly", usedFraction: 0.06 });
  expect(usage.opencode.totals!.tokens).toBe(312_700_000);
  rmSync(home, { recursive: true, force: true });
});

test("a tool that is not installed is left out, and a tool that cannot be measured says why without its stderr", () => {
  const { run } = runOf({
    "claude -p /usage --output-format json": () => ({ stdout: "", stderr: "Error: token sk-live-SECRET-123 was rejected", status: 1 }),
    "agy -p /usage --output-format json": () => ok(AGY_JSON),
    "opencode stats": () => ({ stdout: "", stderr: "", status: null }),        // timed out
  });
  const home = codexHomeWith(null);
  const usage = collectUsage(new Set(["claude", "antigravity", "opencode", "custom"]), run, { now: NOW, codexHome: home, refresh: true });
  expect(Object.keys(usage).sort()).toEqual(["antigravity", "claude", "opencode"]);   // no key made up for custom
  expect(usage.antigravity.windows.length).toBe(4);
  expect(usage.claude.windows).toEqual([]);
  expect(usage.claude.error).toBe("claude -p /usage --output-format json exited 1");
  expect(usage.claude.source).toBe("claude -p /usage");
  expect(usage.claude.observedAt).toBe(NOW);
  expect(JSON.stringify(usage)).not.toContain("sk-live");
  expect(JSON.stringify(usage)).not.toContain("SECRET");
  expect(usage.opencode.error).toMatch(/did not finish/);
  expect(usage.codex).toBeUndefined();
  rmSync(home, { recursive: true, force: true });
});

test("collector: signed-out agy reporting authentication error returns 'not signed in to Antigravity'", () => {
  const { run } = runOf({
    "agy -p /usage --output-format json": () => ({
      stdout: JSON.stringify({ status: "ERROR", error: "authentication failed or timed out" }),
      stderr: "Error: authentication required. Run 'agy' to log in, then retry.",
      status: 1,
    }),
  });
  const home = codexHomeWith(null);
  const usage = collectUsage(new Set(["antigravity"]), run, { now: NOW, codexHome: home, refresh: true });
  expect(usage.antigravity.windows).toEqual([]);
  expect(usage.antigravity.error).toBe("not signed in to Antigravity");
  rmSync(home, { recursive: true, force: true });
});

test("collector: empty claude output retries once and reports 'no output from claude /usage'", () => {
  let attempts = 0;
  const run: UsageRunner = (cmd) => {
    if (cmd[0] === "claude") {
      attempts++;
      return { stdout: "", stderr: "", status: 0 };
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  const home = codexHomeWith(null);
  const usage = collectUsage(new Set(["claude"]), run, { now: NOW, codexHome: home, refresh: true });
  expect(attempts).toBe(2);
  expect(usage.claude.windows).toEqual([]);
  expect(usage.claude.error).toBe("no output from claude /usage");
  rmSync(home, { recursive: true, force: true });
});

test("collector: empty claude output that succeeds on retry parses normally", () => {
  let attempts = 0;
  const run: UsageRunner = (cmd) => {
    if (cmd[0] === "claude") {
      attempts++;
      if (attempts === 1) return { stdout: "", stderr: "", status: 0 };
      return ok(CLAUDE_JSON);
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  const home = codexHomeWith(null);
  const usage = collectUsage(new Set(["claude"]), run, { now: NOW, codexHome: home, refresh: true });
  expect(attempts).toBe(2);
  expect(usage.claude.windows.length).toBe(3);
  expect(usage.claude.error).toBeUndefined();
  rmSync(home, { recursive: true, force: true });
});

test("prime-agent reports the opencode numbers under its own id, from one call", () => {
  const { run, calls } = runOf(HANDLERS);
  const home = codexHomeWith(null);
  const usage = collectUsage(new Set(["opencode", "prime"]), run, { now: NOW, codexHome: home, refresh: true });
  expect(Object.keys(usage).sort()).toEqual(["opencode", "prime-agent"]);
  expect(usage["prime-agent"].totals).toEqual(usage.opencode.totals);
  expect(calls.filter((c) => c.cmd[0] === "opencode").length).toBe(1);
  // prime-agent alone has nothing to read: opencode stats is what carries the numbers.
  const alone = collectUsage(new Set(["prime"]), runOf({}).run, { now: NOW, codexHome: home, refresh: true });
  expect(alone["prime-agent"].windows).toEqual([]);
  expect(alone["prime-agent"].error).toBeTruthy();
  rmSync(home, { recursive: true, force: true });
});

test("codex is read from the newest rollout file's tail, and a device without one says so", () => {
  const home = codexHomeWith(CODEX_LINE);
  const newer = join(home, ".codex", "sessions", "2026", "11", "03", "rollout-2026-11-03T22-00-00-later.jsonl");
  writeFileSync(newer, `${JSON.stringify({ type: "session_meta" })}\n`);
  utimesSync(newer, Date.parse("2026-11-03T19:00:00Z") / 1000, Date.parse("2026-11-03T19:00:00Z") / 1000);
  const usage = collectUsage(new Set(["codex"]), runOf({}).run, { now: NOW, codexHome: home, refresh: true });
  // The newest file holds no reading of its own, so the newest one that does is used: an old reading is still a reading.
  expect(usage.codex.windows[0]).toMatchObject({ window: "weekly", usedFraction: 0.06 });
  rmSync(home, { recursive: true, force: true });
  const empty = codexHomeWith(null);
  const none = collectUsage(new Set(["codex"]), runOf({}).run, { now: NOW, codexHome: empty, refresh: true });
  expect(none.codex.windows).toEqual([]);
  expect(none.codex.error).toMatch(/no codex session files/);
  rmSync(empty, { recursive: true, force: true });
});

test("codex: only the tail of a big rollout is read, and the last reading in it wins", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-codex-"));
  const dir = join(home, ".codex", "sessions", "2026", "11", "04");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-2026-11-04T00-00-00-big.jsonl");
  const earlier = CODEX_LINE.replace('"used_percent":6.0', '"used_percent":50.0');
  const filler = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: "event_msg", i, text: "x".repeat(200) })).join("\n");
  writeFileSync(file, `${JSON.stringify({ type: "session_meta" })}\n${earlier}\n${filler}\n${CODEX_LINE}\n`);
  expect(statSync(file).size).toBeGreaterThan(256 * 1024);
  const usage = collectUsage(new Set(["codex"]), runOf({}).run, { now: NOW, codexHome: home, refresh: true });
  expect(usage.codex.windows[0]).toMatchObject({ usedFraction: 0.06 });      // the newest reading, not the first one in the file
  rmSync(home, { recursive: true, force: true });
});

test("FLEET_USAGE=off measures nothing, so a test that drives the device report never runs a real tool", () => {
  const { run, calls } = runOf(HANDLERS);
  const home = codexHomeWith(CODEX_LINE);
  const before = process.env.FLEET_USAGE;
  process.env.FLEET_USAGE = "off";
  try {
    const usage = collectUsage(new Set(["opencode"]), run, { now: NOW, codexHome: home });
    expect(usage).toEqual({});                     // not "empty windows": nothing was measured, so nothing is reported
    expect(calls).toEqual([]);                     // the runner is never touched
  } finally {
    if (before === undefined) delete process.env.FLEET_USAGE; else process.env.FLEET_USAGE = before;
  }
  // The empty answer was not kept: with the flag gone the next report measures again.
  const measured = collectUsage(new Set(["opencode"]), run, { now: NOW, codexHome: home });
  expect(measured.opencode.totals!.tokens).toBe(312_700_000);
  expect(calls.length).toBe(1);
  rmSync(home, { recursive: true, force: true });
});

test("results are kept for five minutes per process, and a refresh reads the tools again", () => {
  const { run, calls } = runOf(HANDLERS);
  const home = codexHomeWith(null);
  const first = collectUsage(new Set(["opencode"]), run, { now: 1_000_000, codexHome: home });
  const afterFirst = calls.length;
  const second = collectUsage(new Set(["opencode"]), run, { now: 1_000_000 + 60_000, codexHome: home });
  expect(calls.length).toBe(afterFirst);                                   // no tool was run again
  expect(second.opencode.observedAt).toBe(first.opencode.observedAt);      // the same measurement, not a new one
  expect(USAGE_CACHE_MS).toBe(5 * 60_000);
  collectUsage(new Set(["opencode"]), run, { now: 1_000_000 + USAGE_CACHE_MS + 1, codexHome: home });
  expect(calls.length).toBeGreaterThan(afterFirst);                        // the cache expired
  const before = calls.length;
  collectUsage(new Set(["opencode"]), run, { now: 1_000_000, codexHome: home, refresh: true });
  expect(calls.length).toBeGreaterThan(before);                            // and a refresh always reads
  rmSync(home, { recursive: true, force: true });
});

test("the whole collection is bounded by one budget, and what it cannot reach says so", () => {
  const slow = () => { const until = Date.now() + 40; while (Date.now() < until) {} return ok(CLAUDE_JSON); };
  const { run } = runOf({ ...HANDLERS, "claude -p /usage --output-format json": slow });
  const home = codexHomeWith(null);
  const usage = collectUsage(new Set(["claude", "antigravity", "opencode"]), run, { now: NOW, codexHome: home, refresh: true, budgetMs: 25 });
  expect(usage.claude.windows.length).toBe(3);                              // the first one ran
  expect(usage.antigravity.windows).toEqual([]);
  expect(usage.antigravity.error).toMatch(/out of time/);
  expect(usage.opencode.error).toMatch(/out of time/);
  expect(USAGE_TOTAL_MS).toBe(20_000);
  rmSync(home, { recursive: true, force: true });
});

// ---- the hub ----

const { app, store, hub } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
const post = (path: string, body: unknown, as?: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), headers: as ?? human });
const state = async () => (await (await fetch(`${base}/api/state`, { headers: human })).json()) as any;
const newDevice = async (name: string) => {
  const d: any = await (await post("/api/devices", { name })).json();
  return { ...d, dev: { Authorization: `Bearer ${d.token}`, "content-type": "application/json" } };
};

test("a report's usage is sanitised before the UI sees it: capped, coerced, only known keys, garbage dropped", async () => {
  const d = await newDevice("usage-device");
  const window = (over: object = {}) => ({ label: "Week (all models)", window: "weekly", usedFraction: 0.04, resetsAt: 1762699200000, ...over });
  const usage = {
    claude: {
      source: "claude -p /usage", observedAt: 1762199999000, windows: [window(), window({ label: "x".repeat(400) }), ...Array.from({ length: 10 }, () => window())],
      totals: { tokens: "12", sessions: 3, prompts: Number.POSITIVE_INFINITY, note: "n".repeat(400) },
      error: "e".repeat(400), cookie: "secret-cookie", extra: { deep: true },
    },
    codex: { source: "s".repeat(400), observedAt: 1762199999001, windows: [window({ usedFraction: 4.2 }), window({ usedFraction: -3 }), window({ usedFraction: "half" }), window({ resetsAt: "soon" })] },
    antigravity: { source: "agy -p /usage", observedAt: 1762199999000, windows: [window({ window: "monthly" })] },
    opencode: { source: "opencode stats", observedAt: 1762199999000, windows: [], totals: { tokens: 312_700_000, note: "Plan limit is only on the OpenCode Go dashboard" }, error: "" },
    "prime-agent": "not an object",
    custom: { source: "made up", observedAt: 1, windows: [] },
    "not-a-harness": { source: "made up", observedAt: 1, windows: [window()] },
  };
  expect((await post("/device/report", { harnesses: [{ id: "claude", label: "Claude Code", path: "/usr/bin/claude" }], usage }, d.dev)).status).toBe(200);
  const row = (await state()).devices.find((x: any) => x.id === d.id);
  const u = row.usage;
  expect(Object.keys(u).sort()).toEqual(["antigravity", "claude", "codex", "opencode"]);
  // claude: eight windows at most, capped strings, numbers coerced, unknown keys gone
  expect(u.claude.windows.length).toBe(8);
  expect(u.claude.windows[1].label.length).toBe(80);
  expect(u.claude).toMatchObject({ source: "claude -p /usage", observedAt: 1762199999000 });
  expect(u.claude.error.length).toBe(200);
  expect(u.claude.cookie).toBeUndefined();
  expect(u.claude.extra).toBeUndefined();
  expect(u.claude.totals).toEqual({ tokens: 12, sessions: 3, note: "n".repeat(200) });    // +Infinity is not a number the UI can show
  // codex: odd readings are clamped or dropped, but the harness stays because its source is real
  expect(u.codex.source.length).toBe(80);
  expect(u.codex.windows.map((w: any) => w.usedFraction)).toEqual([1, 0, 0.04]);            // clamped; the one that was not a number is gone
  expect(u.codex.windows[0].resetsAt).toBe(1762699200000);
  expect(u.codex.windows[2].resetsAt).toBe(null);                                          // "soon" is not a time
  expect(u.codex.windows.length).toBe(3);
  // an unknown window name is kept as other, so it is never silently hidden
  expect(u.antigravity.windows[0].window).toBe("other");
  expect(u.opencode.totals).toEqual({ tokens: 312_700_000, note: "Plan limit is only on the OpenCode Go dashboard" });
  expect(u.opencode.error).toBeUndefined();                                                // an empty error is not an error
  expect(JSON.stringify(await state())).not.toContain(d.token);
});

test("a harness whose own shape is unusable is dropped, never shown as a hole", async () => {
  const d = await newDevice("usage-shape");
  const w = { label: "Week", window: "weekly", usedFraction: 0.04, resetsAt: 1762699200000 };
  await post("/device/report", { usage: {
    claude: { observedAt: 1762199999000, windows: [w] },                              // no source: nothing to say how it was measured
    codex: { source: "codex session files", observedAt: "whenever", windows: [w] },   // no usable time: "measured when" cannot be shown
    opencode: { source: "opencode stats", observedAt: 1762199999000, windows: [w, "nope", { label: "", usedFraction: 0.1 }, { label: "x" }] },
    "prime-agent": { source: "opencode stats", observedAt: 1762199999000, windows: "not an array", totals: "nope" },
  } }, d.dev);
  const u = (await state()).devices.find((x: any) => x.id === d.id).usage;
  expect(Object.keys(u).sort()).toEqual(["opencode", "prime-agent"]);
  expect(u.opencode.windows).toEqual([w]);            // a window with no label or no fraction is not a reading
  expect(u["prime-agent"]).toEqual({ source: "opencode stats", observedAt: 1762199999000, windows: [] });
});

test("a good usage reading round-trips through /api/state unchanged, unrounded", async () => {
  const d = await newDevice("usage-good");
  const usage = {
    claude: { source: "claude -p /usage", observedAt: NOW, windows: [
      { label: "session", window: "session", usedFraction: 0.08, resetsAt: Date.parse("2026-11-03T22:00:00Z") },
      { label: "week (all models)", window: "weekly", usedFraction: 0.04, resetsAt: Date.parse("2026-11-09T15:00:00Z") },
    ] },
    antigravity: { source: "agy -p /usage", observedAt: NOW, windows: [{ label: "Gemini Models · Weekly Limit Remaining", window: "weekly", usedFraction: 0.0158958435058594, resetsAt: Date.parse("2026-11-10T13:18:17Z") }] },
    codex: { source: "codex session files", observedAt: NOW, windows: [] , error: "last reading is from before the window reset" },
    opencode: { source: "opencode stats", observedAt: NOW, windows: [], totals: { sessions: 18, prompts: 219, tokens: 312_700_000, note: "Plan limit is only on the OpenCode Go dashboard" } },
  };
  await post("/device/report", { usage }, d.dev);
  const row = (await state()).devices.find((x: any) => x.id === d.id);
  expect(row.usage).toEqual(usage);
  expect(row.usage.claude.windows[1].resetsAt).toBe(Date.parse("2026-11-09T15:00:00Z"));   // epoch ms, not seconds
});
