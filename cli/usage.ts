// Subscription usage, measured on the device.
//
// Every harness here reports a different way: Claude prints prose, Antigravity prints JSON, Codex only writes session
// files, opencode prints totals with no limit at all. Each has one pure parser, so a format change is caught by a test
// and never guessed at. A tool that cannot be measured gets a short reason and no numbers: unmeasured is not "full".

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type UsageWindowKind = "5h" | "session" | "weekly" | "other";
export interface UsageWindow { label: string; window: UsageWindowKind; usedFraction: number; resetsAt: number | null }
export interface UsageTotals { tokens?: number; sessions?: number; prompts?: number; note?: string }
export interface HarnessUsage { source: string; observedAt: number; windows: UsageWindow[]; totals?: UsageTotals; error?: string }
export type Usage = Record<string, HarnessUsage>;

/** The harness ids a report may use, in the order they are collected. */
export const USAGE_HARNESSES = ["claude", "codex", "antigravity", "opencode", "prime-agent"];
/** The ids the CLI detects a tool by, mapped to the ids the contract reports under. */
export const USAGE_IDS: Record<string, string> = { claude: "claude", codex: "codex", antigravity: "antigravity", opencode: "opencode", prime: "prime-agent" };

export const USAGE_CMD_MS = 15_000;          // one tool may not hold the report loop longer than this
export const USAGE_TOTAL_MS = 20_000;        // ... and all of them together no longer than this
export const USAGE_CACHE_MS = 5 * 60_000;    // a measurement is reused this long, like the model catalog

const NOTE_NO_LIMIT = "Plan limit is only on the OpenCode Go dashboard";
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

// ---------- claude ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/**
 * A line such as `Current week (all models): 4% used · resets Nov 9 at 5:59pm (Europe/Istanbul)`.
 * The text is not a stable API, so only this one shape is read, and anything else is ignored rather than guessed at.
 */
const CLAUDE_LINE = /^Current (.+?):\s*([\d.]+)% used\b[^\n]*?\bresets\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b[^\n]*?\(([^)]+)\)/i;

/** How far a zone's clock is ahead of UTC at an instant: it is what turns a printed wall time into a real moment. */
const zoneOffsetMs = (utcMs: number, zone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const at = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return Date.UTC(at("year"), at("month") - 1, at("day"), at("hour"), at("minute"), at("second")) - Math.floor(utcMs / 1000) * 1000;
};

/** The moment a clock in `zone` shows this wall time, or null when no such moment exists (a DST gap, a date like Feb 30, an unknown zone). */
const instantOf = (y: number, month: number, day: number, hour: number, minute: number, zone: string): number | null => {
  const probe = new Date(Date.UTC(y, month, day));
  if (probe.getUTCMonth() !== month || probe.getUTCDate() !== day) return null;    // the date does not roll over into the next month
  const wall = Date.UTC(y, month, day, hour, minute);
  let at = wall;
  try { for (let i = 0; i < 2; i++) at = wall - zoneOffsetMs(at, zone); } catch { return null; }   // twice: an offset may change across the boundary
  try { return zoneOffsetMs(at, zone) === wall - at ? at : null; } catch { return null; }
};

/** The reset time as printed carries no year: the next occurrence of that date and time, or null when it cannot be placed. */
const nextReset = (now: number, month: number, day: number, hour: number, minute: number, zone: string): number | null => {
  const thisYear = new Date(now).getUTCFullYear();
  for (let y = thisYear; y <= thisYear + 2; y++) {
    const at = instantOf(y, month, day, hour, minute, zone);
    if (at !== null && at > now) return at;
  }
  return null;
};

/** `claude -p /usage` with `--output-format json`: every `Current <label>: N% used · resets ...` line is one window. */
export function parseClaudeUsage(resultText: string, now: number): HarnessUsage {
  const source = "claude -p /usage";
  const fail = (error: string): HarnessUsage => ({ source, observedAt: now, windows: [], error });
  const text = String(resultText ?? "").trim();
  if (!text) return fail("no output from claude /usage");
  if (/Total cost:/i.test(stripAnsi(text))) {
    return fail("claude /usage reports session cost, not subscription limits");
  }
  const windows: UsageWindow[] = [];
  for (const raw of text.split("\n")) {
    const line = stripAnsi(raw).trim();
    if (!line.startsWith("Current ")) continue;
    const m = CLAUDE_LINE.exec(line);
    if (!m) continue;
    const label = m[1].trim(), month = MONTHS.indexOf(m[3].slice(0, 3).toLowerCase());
    const day = Number(m[4]), hour12 = Number(m[5]), minute = m[6] === undefined ? 0 : Number(m[6]), percent = Number(m[2]);
    if (!label || month < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59 || !Number.isFinite(percent)) continue;
    const hour = (hour12 % 12) + (m[7].toLowerCase() === "p" ? 12 : 0);
    windows.push({
      label,
      window: /^session\b/i.test(label) ? "session" : /^week\b/i.test(label) ? "weekly" : "other",
      usedFraction: clamp01(percent / 100),
      resetsAt: nextReset(now, month, day, hour, minute, m[8].trim()),
    });
  }
  return windows.length ? { source, observedAt: now, windows } : fail("unrecognised /usage output");
}

// ---------- antigravity ----------

/** `agy -p /usage --output-format json`: each bucket of each group is one window; used = 1 - remaining. */
export function parseAgyUsage(jsonText: string, now: number = Date.now()): HarnessUsage {
  const source = "agy -p /usage";
  const fail = (error: string): HarnessUsage => ({ source, observedAt: now, windows: [], error });
  let json: any;
  try { json = JSON.parse(String(jsonText ?? "")); } catch { return fail("agy printed no JSON it could read"); }
  if (!json || typeof json !== "object") return fail("agy printed no JSON it could read");
  if (json.status !== undefined && json.status !== "SUCCESS") {
    const errText = typeof json.error === "string" ? json.error : typeof json.message === "string" ? json.message : "";
    if (/authentication/i.test(errText)) {
      return fail("not signed in to Antigravity");
    }
    const status = typeof json.status === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(json.status) ? json.status : "an unexpected status";
    return fail(`agy reported status ${status}`);
  }
  const groups = json?.command?.data?.groups ?? json?.data?.command?.data?.groups;
  if (!Array.isArray(groups)) return fail("agy printed no usage groups");
  const windows: UsageWindow[] = [];
  for (const group of groups) {
    const groupName = typeof group?.name === "string" ? group.name.trim() : "";
    if (!groupName) continue;
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const remaining = Number(bucket?.remaining_fraction);
      const name = typeof bucket?.name === "string" ? bucket.name.replace(/\s*limit remaining\s*$/i, "").trim() : "";    // the bar shows what is used, so "Remaining" in the label would contradict it
      if (!name || !Number.isFinite(remaining)) continue;
      const reset = typeof bucket?.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
      windows.push({
        label: `${groupName} · ${name}`,
        window: bucket?.window === "weekly" ? "weekly" : bucket?.window === "5h" ? "5h" : "other",
        usedFraction: clamp01(1 - remaining),
        resetsAt: Number.isFinite(reset) ? reset : null,
      });
    }
  }
  return windows.length ? { source, observedAt: now, windows } : fail("agy reported no usage windows");
}

// ---------- codex ----------

/** The `rate_limits` block of one rollout line: `payload.rate_limits`, wherever that line keeps it. */
const rateLimitsIn = (value: unknown, depth = 0): any => {
  if (!value || typeof value !== "object" || depth > 6) return null;
  const o = value as any;
  if (o.rate_limits && typeof o.rate_limits === "object") return o.rate_limits;
  for (const k of Object.keys(o)) { const found = rateLimitsIn(o[k], depth + 1); if (found) return found; }
  return null;
};

/** One `{used_percent, window_minutes, resets_at}` reading. `resets_at` is epoch SECONDS. */
const codexWindow = (b: any): UsageWindow | null => {
  if (!b || typeof b !== "object") return null;
  const used = Number(b.used_percent), minutes = Number(b.window_minutes);
  if (!Number.isFinite(used) || !Number.isFinite(minutes)) return null;
  const seconds = Number(b.resets_at);
  const what = minutes === 10080 ? { window: "weekly" as const, label: "Week" } : minutes === 300 ? { window: "5h" as const, label: "5 hour" } : { window: "other" as const, label: `${minutes} min` };
  return { ...what, usedFraction: clamp01(used / 100), resetsAt: b.resets_at !== null && Number.isFinite(seconds) ? seconds * 1000 : null };
};

/** The last `rate_limits` line of the newest codex rollout file. A reading older than its own reset is stale, and says so. */
export function parseCodexRateLimits(lastLineJson: string, fileMtimeMs: number, now: number): HarnessUsage {
  const source = "codex session files";
  const fail = (error: string): HarnessUsage => ({ source, observedAt: Math.round(fileMtimeMs), windows: [], error });
  let line: any;
  try { line = JSON.parse(String(lastLineJson ?? "")); } catch { return fail("the last rate-limit line could not be read"); }
  const limits = rateLimitsIn(line);
  if (!limits) return fail("the last rate-limit line could not be read");
  const windows = [codexWindow(limits.primary), codexWindow(limits.secondary)].filter((w): w is UsageWindow => w !== null);
  if (!windows.length) return fail("the last rate-limit line names no window");
  if (windows.some((w) => w.resetsAt !== null && w.resetsAt <= now)) return fail("last reading is from before the window reset");
  return { source, observedAt: Math.round(fileMtimeMs), windows };
}

// ---------- opencode (and prime-agent, which reads the same numbers) ----------

const SCALE: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9 };
const STAT_LINE = /^\s*(\d[\d,]*(?:\.\d+)?)\s*([kmb]?)\s+(sessions|prompts|tokens)\s*$/i;

/** `opencode stats`: totals only, because the plan limit is on a dashboard this cannot reach. */
export function parseOpencodeStats(text: string, now: number = Date.now()): HarnessUsage {
  const source = "opencode stats", totals: UsageTotals = {};
  for (const raw of String(text ?? "").split("\n")) {
    for (const part of stripAnsi(raw).split("·")) {
      const m = STAT_LINE.exec(part);
      if (!m) continue;
      const n = Number(m[1].replace(/,/g, "")) * SCALE[m[2].toLowerCase()];
      if (Number.isFinite(n)) totals[m[3].toLowerCase() as "sessions" | "prompts" | "tokens"] = n;
    }
  }
  if (totals.sessions === undefined && totals.prompts === undefined && totals.tokens === undefined)
    return { source, observedAt: now, windows: [], error: "unrecognised `opencode stats` output" };
  return { source, observedAt: now, windows: [], totals: { ...totals, note: NOTE_NO_LIMIT } };
}

// ---------- the collector ----------

/** One command's outcome. `status: null` means it did not finish: it timed out or could not start. */
export interface UsageRun { stdout: string; stderr: string; status: number | null }
/** A runner takes an argv array (never a shell string) and the cwd and timeout it must respect. Tests pass their own. */
export type UsageRunner = (cmd: string[], opts?: { cwd?: string; timeoutMs?: number }) => string | UsageRun;

/** The same PATH the rest of the CLI uses, so a tool installed in a login-only folder is still found. */
const toolPath = () => [dirname(process.execPath), `${homedir()}/.opencode/bin`, `${homedir()}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? ""].join(":");

const defaultRun: UsageRunner = (cmd, opts) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", cwd: opts?.cwd, timeout: opts?.timeoutMs ?? USAGE_CMD_MS, maxBuffer: 4 << 20, env: { ...process.env, PATH: toolPath() } });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: typeof r.status === "number" ? r.status : null };
};

const asRun = (r: string | UsageRun): UsageRun => (typeof r === "string" ? { stdout: r, stderr: "", status: 0 } : r);

/** The tail of a file, because a rollout grows to megabytes and the reading is always at the end. */
const readTail = (file: string, bytes = 256 * 1024): string => {
  const size = statSync(file).size, start = Math.max(0, size - bytes);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
};

/** The newest rollout files, newest first. The walk is bounded: a laptop can hold years of sessions. */
const newestRollouts = (dir: string, limit = 5): { file: string; mtime: number }[] => {
  const found: { file: string; mtime: number }[] = [];
  const walk = (at: string, depth: number) => {
    if (depth > 6 || found.length >= 400) return;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(at, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) { try { found.push({ file: p, mtime: statSync(p).mtimeMs }); } catch {} }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
};

/** The newest codex reading, from the newest file that holds one. Nothing is read into the report but the numbers. */
const readCodex = (codexHome: string, now: number): HarnessUsage => {
  const source = "codex session files";
  const files = newestRollouts(join(codexHome, ".codex", "sessions"));
  if (!files.length) return { source, observedAt: now, windows: [], error: "no codex session files on this device" };
  for (const { file, mtime } of files) {
    let line: string | undefined;
    try { line = readTail(file).split("\n").reverse().find((l) => l.includes("rate_limits")); } catch { continue; }
    if (line) return parseCodexRateLimits(line, mtime, now);      // a file without a reading is a session that used no model yet
  }
  return { source, observedAt: now, windows: [], error: "no codex session file holds a rate-limit reading" };
};

let usageCache: { key: string; at: number; value: Usage } | null = null;

const short = (e: unknown): string => (e instanceof Error && e.message ? e.message : "could not measure usage here").slice(0, 200);
const capError = (u: HarnessUsage): HarnessUsage => (u.error ? { ...u, error: u.error.slice(0, 200) } : u);

/**
 * Measure every installed harness. One tool failing never touches the others, and nothing takes longer than the
 * whole-collection budget (`budgetMs` shrinks it, so a test can prove that without waiting twenty seconds).
 * Results are reused for five minutes per process unless `refresh` is set.
 * `have` takes the ids the CLI detects a tool by ("prime") as well as the contract ids ("prime-agent").
 * `FLEET_USAGE=off` measures nothing and returns {}, so a test that drives the real report path runs no real tool.
 */
export function collectUsage(have: Set<string>, run: UsageRunner = defaultRun, opts: { now?: number; codexHome?: string; refresh?: boolean; budgetMs?: number } = {}): Usage {
  if (process.env.FLEET_USAGE === "off") return {};
  const now = opts.now ?? Date.now();
  const codexHome = opts.codexHome ?? process.env.FLEET_CODEX_HOME ?? homedir();
  const keys = new Set([...have].map((id) => USAGE_IDS[id] ?? id));
  const key = `${[...keys].sort().join(",")}|${codexHome}`;
  if (!opts.refresh && usageCache && usageCache.key === key && now - usageCache.at >= 0 && now - usageCache.at < USAGE_CACHE_MS) return usageCache.value;

  const deadline = Date.now() + (opts.budgetMs ?? USAGE_TOTAL_MS);
  const usage: Usage = {};
  // Time left for one command: never more than its own limit, never past the budget the whole collection has.
  const runTool = (cmd: string[], cwd?: string): UsageRun => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("the device ran out of time measuring usage");
    return asRun(run(cmd, { ...(cwd ? { cwd } : {}), timeoutMs: Math.min(USAGE_CMD_MS, left) }));
  };
  const tool = (cmd: string[], cwd?: string): UsageRun => {
    const r = runTool(cmd, cwd);
    if (r.status !== 0) throw new Error(`${cmd.join(" ")} ${r.status === null ? "did not finish (it timed out or could not start)" : `exited ${r.status}`}`);
    return r;
  };
  const measure = (id: string, source: string, read: () => HarnessUsage) => {
    try { usage[id] = capError(read()); } catch (e) { usage[id] = { source, observedAt: now, windows: [], error: short(e) }; }
  };

  if (keys.has("claude")) measure("claude", "claude -p /usage", () => {
    // In a fresh empty folder, so it cannot pick up a project's settings or write anything of its own.
    const dir = mkdtempSync(join(tmpdir(), "fleet-usage-"));
    try {
      let r = runTool(["claude", "-p", "/usage", "--output-format", "json"], dir);
      if (!r.stdout.trim() && r.status === 0) {
        // Timing or lock contention on older Claude releases: retry once.
        r = runTool(["claude", "-p", "/usage", "--output-format", "json"], dir);
      }
      if (r.status !== 0) throw new Error(`claude -p /usage --output-format json ${r.status === null ? "did not finish (it timed out or could not start)" : `exited ${r.status}`}`);
      if (!r.stdout.trim()) return { source: "claude -p /usage", observedAt: now, windows: [], error: "no output from claude /usage" };
      let result: unknown;
      try { result = JSON.parse(r.stdout)?.result; } catch { throw new Error("claude -p /usage printed no JSON it could read"); }
      if (typeof result !== "string") throw new Error("claude -p /usage printed no /usage text");
      return parseClaudeUsage(result, now);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  if (keys.has("codex")) measure("codex", "codex session files", () => readCodex(codexHome, now));
  if (keys.has("antigravity")) measure("antigravity", "agy -p /usage", () => {
    const r = runTool(["agy", "-p", "/usage", "--output-format", "json"]);
    if (r.status !== 0) {
      if (r.stdout) {
        const parsed = parseAgyUsage(r.stdout, now);
        if (parsed.error === "not signed in to Antigravity") return parsed;
      }
      if (/authentication (required|failed)/i.test(r.stderr)) {
        return { source: "agy -p /usage", observedAt: now, windows: [], error: "not signed in to Antigravity" };
      }
      throw new Error(`agy -p /usage --output-format json ${r.status === null ? "did not finish (it timed out or could not start)" : `exited ${r.status}`}`);
    }
    return parseAgyUsage(r.stdout, now);
  });
  if (keys.has("opencode")) measure("opencode", "opencode stats", () => parseOpencodeStats(tool(["opencode", "stats"]).stdout, now));
  // prime-agent runs on the same subscription and reads the same numbers; on its own it has nothing to read.
  if (keys.has("prime-agent")) {
    const same = usage.opencode;
    usage["prime-agent"] = same
      ? { ...same, ...(same.totals ? { totals: { ...same.totals } } : {}) }
      : { source: "opencode stats", observedAt: now, windows: [], error: "prime-agent usage is read with opencode stats, which is not installed here" };
  }

  usageCache = { key, at: now, value: usage };
  return usage;
}
