#!/usr/bin/env bun
// fleet: set up and manage fleet agents on this device with one command each.
//
//   fleet hub init [--owner N --host IP --port P --dir D]   set up and start the hub on THIS machine (start here)
//   fleet hub status|start|stop|logs|token|set|service      run and inspect it
//   fleet login <hub-url> <human-token>            once per machine you administer from
//   fleet agent add <name> --harness claude|opencode|prime-agent|codex|antigravity|custom [--dir DIR] [--model M] [--permissions safe|edits|open]
//                          [--ssh HOST] [--owner NAME] [--print-join] [--no-start]
//   fleet agent reconnect <name> --harness H ...   issue a new token for an existing agent and set it up here
//   fleet agent rm <name>                          revoke on the hub and remove here
//   fleet install [--hub URL --token T --name N]   print setup instructions for an agent to follow itself
//   fleet join <hub-url> <token|-> --name N --harness H ...   the device side of "agent add" (token - reads stdin)
//   fleet ls | start <n> | stop <n> | restart <n> | logs <n> [-f] | update | doctor
//   fleet service install|uninstall <n>            start at login (macOS)
//
// Everything lives in ~/.fleet (override with FLEET_HOME). Tokens are stored with owner-only permissions.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareWorktree, type CanonicalWork } from "../shared/worktree";
import { underRoots } from "../shared/paths";
import { HARNESSES, detectHarnesses, harnessInfo, normalizeHarnessName, validateSessionId, type HarnessId } from "../shared/harnesses";
import { collectUsage } from "./usage";

export type Harness = HarnessId;
export type Permissions = "safe" | "edits" | "open";
export interface AgentConfig { project?:string;branch?:string;base?:string; name: string; hubUrl: string; token: string; harness: Harness; workdir: string; model?: string; provider?: string; permissions: Permissions; runCmd?: string; resumeCmd?: string; session?: string }

// ---------- pure helpers (tested) ----------

const BOOLEAN_FLAGS = new Set(["no-start", "print-join", "print-prompt", "no-launcher", "create", "f", "follow"]);

export function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [], flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f") { flags.f = true; continue; }
    if (!a.startsWith("--")) { _.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2), next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && !BOOLEAN_FLAGS.has(key)) { flags[key] = next; i++; } else flags[key] = true;
  }
  return { _, flags };
}

/** Accepts the names people type. Anything not supported yet is rejected. */
export function normalizeHarness(v: unknown): Harness | null {
  return normalizeHarnessName(v);
}

export const validName = (n: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(n) && !["all", "everyone", "human"].includes(n);   // those three address everyone in a message

/** What an agent may do when the helper runs it without a person at the keyboard. "safe" adds nothing. */
export function extraArgsFor(harness: Harness, permissions: Permissions): string[] {
  if (harness === "prime") {
    if (permissions === "open") return [];
    throw new Error("prime-agent has no safe mode: it reaches the fleet only through its Python REPL, which can run anything on this machine. Re-run with --permissions open to confirm.");
  }
  if (harness === "codex") {
    // Codex sandboxes the commands it runs. Safe and edits keep that sandbox (read-only, or writable in the folder); open turns it off.
    if (permissions === "open") return ["--dangerously-bypass-approvals-and-sandbox"];
    if (permissions === "safe") return ["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'];
    if (permissions === "edits") return ["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"'];
    throw new Error(`permissions must be safe, edits or open (got ${permissions})`);
  }
  if (harness === "antigravity") {
    if (permissions !== "safe" && permissions !== "edits" && permissions !== "open") throw new Error(`permissions must be safe, edits or open (got ${permissions})`);
    if (permissions === "open") return ["--dangerously-skip-permissions"];   // it approves every tool for this run
    // These settings live for this session only and are never saved, so the user's own settings.json is untouched.
    // "request-review" is the preset that asks first; "strict" would ignore even allow rules, and then the fleet tools
    // themselves could not run, which is the one thing this mode must keep. With nobody at the keyboard every request
    // it still has to make is refused, and deny rules are absolute, so the deny list is what actually holds.
    const deny = ["command(*)", "read_url(*)", "execute_url(*)", ...(permissions === "safe" ? ["read_file(*)", "write_file(*)"] : [])];
    const settings = {
      toolPermission: "request-review",
      allowNonWorkspaceAccess: false,                       // never outside the folder, whatever the owner's settings say
      permissions: { allow: ["mcp(fleet/*)"], deny, ask: [] },   // ask: [] so an inherited ask rule cannot block a fleet tool
    };
    return [
      "--settings", JSON.stringify(settings),
      // Edits are approved in the folder; shell commands stay denied by the rule above.
      ...(permissions === "edits" ? ["--mode", "accept-edits"] : []),
    ];
  }
  if (harness === "custom") {
    if (permissions === "open") return [];
    throw new Error("A custom harness is a command you wrote, so the helper cannot limit what it does. Re-run with --permissions open to confirm.");
  }
  if (permissions === "safe") return [];
  if (harness === "claude") {
    if (permissions === "edits") return ["--permission-mode", "acceptEdits"];
    if (permissions === "open") return ["--dangerously-skip-permissions"];
  } else {
    if (permissions === "open") return ["--auto"];
    if (permissions === "edits") throw new Error("opencode supports permissions safe or open only");
  }
  throw new Error(`permissions must be safe, edits or open (got ${permissions})`);
}

export function permissionNote(harness: Harness, permissions: Permissions): string {
  if (harness === "custom") return "Permissions: OPEN (the only mode for a custom command). The helper cannot limit what your command does, and it cannot be sandboxed, so it will refuse requests from outside agents. Use it only in a folder and on a device you are happy to expose.";
  if (harness === "codex" && permissions === "open") return "Permissions: OPEN. Codex runs without its sandbox and without asking: it can run anything on this machine, including reading files outside its folder. Use it only in a folder and on a device you are happy to expose.";
  if (harness === "codex" && permissions === "edits") return "Permissions: edits. Codex can edit files in its folder, inside its own sandbox, and cannot run commands outside it.";
  if (harness === "codex") return "Permissions: safe. Codex runs in its read-only sandbox with the fleet tools: it can read, talk, report and ask you, but not change files.";
  if (harness === "antigravity" && permissions === "open") return "Permissions: OPEN. Antigravity approves every tool call for this run (--dangerously-skip-permissions): it can run commands and read files anywhere on this machine without asking. Use it only in a folder and on a device you are happy to expose.";
  if (harness === "antigravity" && permissions === "edits") return "Permissions: edits. Antigravity may read and edit files in its folder and has the fleet tools. Shell commands and web access are denied by rules this run carries, and reading files outside the folder is off. These limits are enforced by Antigravity's own permission engine, not an OS sandbox, so treat them as a policy the tool applies to itself. Requests from agents outside your team are refused.";
  if (harness === "antigravity") return "Permissions: safe. Antigravity gets the fleet tools only: it can talk, report and ask you. Reading and writing files, shell commands and web access are denied by rules this run carries, and anything else it would have to ask about is refused because nobody is at the keyboard. These limits are enforced by Antigravity's own permission engine, not an OS sandbox, so treat them as a policy the tool applies to itself. Requests from agents outside your team are refused.";
  if (harness === "prime") return "Permissions: OPEN (the only mode for prime-agent). It reaches the fleet only through its Python REPL, which can run anything on this machine and read any file. It cannot be sandboxed, so it will refuse requests from outside agents. Use it only in a folder and on a device you are happy to expose.";
  if (permissions === "safe") return "Permissions: safe. This agent gets the fleet tools only: it can talk, report and ask you, but it cannot edit files or run commands. Re-run with --permissions edits or open to change that.";
  if (permissions === "edits") return "Permissions: edits. This agent can edit files in its folder but cannot run shell commands.";
  return `Permissions: OPEN. This agent can run anything on this machine without asking, including reading files outside its folder${harness === "claude" ? " (it skips every permission check)" : ""}. Use it only in a folder and on a device you are happy to expose.`;
}

/** What an agent reads to set itself up. With a hub address and token the lines are ready to run; without, they carry placeholders. */
export function installInstructions(o: { hubUrl?: string; token?: string; name?: string }): string {
  const hub = o.hubUrl ?? "<hub-url>", token = o.token ?? "<token>", name = o.name ?? "<name>";
  const join = `fleet join ${hub} ${token} --name ${name} --dir <the folder you work in>`;
  return [
    "# Join a fleet",
    "",
    "A fleet hub lets agents on different devices share tasks, talk to each other, and ask the human when they are stuck. You are being added as one of its agents. Do the steps below yourself; stop and tell the human only if something fails.",
    "",
    `Hub: ${hub}    Your name: ${name}`,
    "",
    `Your token is a password. Never paste, repeat or print it anywhere except the commands below, and never commit it to a file.`,
    "",
    "## 0. Get the fleet command",
    "",
    `If \`fleet\` is not installed, install it (it needs bun, https://bun.sh):`,
    "",
    `  curl -fsSL ${hub}/install.sh | sh`,
    "",
    "If `fleet` is still not found afterwards, use `~/.local/bin/fleet` wherever the steps below say `fleet`.",
    "",
    "## 1. Which tool are you?",
    "",
    "If you are one of these, run the matching line and you are done (the fleet command sets up the hub connection and the wake-up helper for you):",
    "",
    `  Claude Code:   ${join} --harness claude`,
    `  opencode:      ${join} --harness opencode --model <the model you run on, as 'opencode models' lists it>`,
    `  prime-agent:   ${join} --harness prime-agent --model <the model you run on> --permissions open`,
    `  Antigravity:   ${join} --harness antigravity --model <the model you run on, as 'agy models' lists it>`,
    "",
    "## 2. Any other tool: write your own command",
    "",
    "The fleet wakes you only when something arrives, by running ONE short turn of your tool in the background. For that it needs a command. You know your own tool, so write it:",
    "",
    "a. Register the hub's tools with yourself, the way your tool registers MCP servers (a config file or a command):",
    `   URL: ${hub}/mcp    header: Authorization: Bearer ${token}`,
    "   If your tool can read the token from an environment variable, use FLEET_TOKEN: the helper sets it on every run, so the token need not be written into a config file.",
    "",
    "b. Find the command that runs ONE prompt without a person, prints your reply to stdout, and exits. Examples of the shape: `mytool run -p \"...\"`, `mytool --prompt \"...\"`.",
    "",
    "c. Find how the same command CONTINUES an earlier conversation by an id you choose. If it can only continue \"the latest\" session, say so to the human instead: that can mix conversations when two agents share a folder.",
    "",
    "d. Turn them into two templates. {prompt} is replaced by the text to answer (as one argument, never run through a shell), {session} by a session id, {workdir} by your folder. No shell: quote with single or double quotes only.",
    "",
    `   ${join} --harness custom --permissions open \\`,
    `     --run-cmd '<first turn, for example: mytool run --session {session} -p {prompt}>' \\`,
    `     --resume-cmd '<later turns, for example: mytool run --resume {session} -p {prompt}>'`,
    "",
    "   Leave out --resume-cmd only if your tool keeps no state between runs (then each wake starts fresh, which is worse).",
    "",
    "e. fleet runs a self-check before going online: one turn, then a second turn on the same session that must recall a word from the first. If it fails it prints why; fix the command and run the join again. Your token stays valid.",
    "",
    "Note for the human: a custom command cannot be sandboxed, so it needs --permissions open, and it refuses requests from agents outside your team.",
    "",
    "## 3. Check",
    "",
    "  fleet ls        your name should show as running and online",
    "  fleet logs " + name + "     if it does not",
    "",
    "From then on you are woken only when the hub has something for you. Use the fleet tools to answer; do not print answers in the terminal.",
    "",
  ].join("\n");
}

/** A POSIX shell script that installs the `fleet` command from this hub: `curl -fsSL <hub>/install.sh | sh`.
 * The launcher it writes holds bun's full path, so it works in shells (and agents) whose PATH has no bun. */
export function installScript(hubUrl: string): string {
  return `#!/bin/sh
# Installs the fleet command from ${hubUrl}
set -e
HUB='${hubUrl}'
BUN=$(command -v bun 2>/dev/null || true)
[ -n "$BUN" ] || { [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"; } || true
if [ -z "$BUN" ]; then
  echo "fleet needs bun, and it is not installed. Install it first: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
mkdir -p "$HOME/.fleet" "$HOME/.local/bin"
curl -fsSL "$HUB/fleet.ts" -o "$HOME/.fleet/fleet.ts.new" || { echo "Could not download $HUB/fleet.ts. Is the address right and the hub running?" >&2; exit 1; }
mv "$HOME/.fleet/fleet.ts.new" "$HOME/.fleet/fleet.ts"
printf '#!/bin/sh\nexec "%s" "%s/.fleet/fleet.ts" "$@"\n' "$BUN" "$HOME" > "$HOME/.local/bin/fleet"
chmod +x "$HOME/.local/bin/fleet"
echo "Installed: $HOME/.local/bin/fleet"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo 'Add it to your PATH (put this line in ~/.zshrc or ~/.bashrc):  export PATH="$HOME/.local/bin:$PATH"' ;;
esac
echo "Next: fleet login $HUB <human-token>"
`;
}

/** Whether a session id can be adopted by this harness. Returns the reason it cannot, or null. */
export function validateSession(harness: Harness, id: string): string | null {
  return validateSessionId(harness, id);
}

/** Where Claude Code keeps a folder's sessions: the path with every non-alphanumeric character turned into a dash. */
export function claudeProjectDir(workdir: string, home = process.env.FLEET_CLAUDE_HOME ?? homedir()): string {
  return join(home, ".claude", "projects", workdir.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** The Claude sessions a folder has, newest first, each with the start of its first message so they can be told apart. */
export function listClaudeSessions(workdir: string, home = process.env.FLEET_CLAUDE_HOME ?? homedir()): { id: string; modified: number; preview: string }[] {
  const dir = claudeProjectDir(workdir, home);
  if (!existsSync(dir)) return [];
  const textOf = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (p && typeof p.text === "string" ? p.text : "")).join(" ") : "";
  return readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => {
    const file = join(dir, n);
    let preview = "";
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (o.type === "user" && o.message) { const text = textOf(o.message.content); const cut = text.lastIndexOf("Now handle these items from the hub:"); preview = (cut >= 0 ? text.slice(cut + "Now handle these items from the hub:".length) : text).replace(/\s+/g, " ").trim().slice(0, 100); if (preview) break; } } catch {}
      }
    } catch {}
    return { id: n.slice(0, -".jsonl".length), modified: statSync(file).mtimeMs, preview };
  }).sort((a, b) => b.modified - a.modified);
}

/** The Codex sessions that were started in a folder, newest first. Codex files them by date and records the folder in each one's first line. */
export function listCodexSessions(workdir: string, home = process.env.FLEET_CODEX_HOME ?? homedir()): { id: string; modified: number; preview: string }[] {
  return allCodexSessions(home).filter((s) => s.cwd === workdir).map(({ cwd: _cwd, ...rest }) => rest);
}

/** Every Codex session on the machine with the folder it started in (the device offers the ones inside its allowed folders). */
export function allCodexSessions(home = process.env.FLEET_CODEX_HOME ?? homedir()): { id: string; cwd: string; modified: number; preview: string }[] {
  const root = join(home, ".codex", "sessions");
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && depth < 4) walk(join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) files.push(join(dir, e.name));
    }
  };
  walk(root, 0);
  const out: { id: string; cwd: string; modified: number; preview: string }[] = [];
  for (const file of files) {
    let lines: string[];
    try { lines = readFileSync(file, "utf8").split("\n"); } catch { continue; }
    let meta: any = null;
    try { const first = JSON.parse(lines[0]); if (first.type === "session_meta") meta = first.payload; } catch {}
    if (!meta || typeof meta.cwd !== "string" || typeof meta.id !== "string") continue;
    let preview = "";
    for (const line of lines.slice(1)) {
      try {
        const o = JSON.parse(line), p = o.payload;
        if (p?.role === "user" && Array.isArray(p.content)) {
          const t = p.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ").replace(/\s+/g, " ").trim();
          if (t && !t.startsWith("<")) { preview = t.slice(0, 100); break; }
        }
      } catch {}
    }
    out.push({ id: meta.id, cwd: meta.cwd, modified: statSync(file).mtimeMs, preview });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** opencode prints one provider/model per line. The model part can hold more slashes and capitals (wandb/openai/gpt-oss-120b), so only the provider is fixed. */
export function parseOpencodeModels(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l) && !/\s/.test(l));
}

/** Antigravity CLI prints one model per line as `slug<TAB>Display Name`; its "Fetching available models..." note goes to
 * stderr, but a version that writes it to stdout is survived too. Only the exact slug is kept: the display name is never
 * turned into an id, and a line without a tab (a note, a warning, a table header) is not a model. */
export function parseAgyModels(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();           // colour codes, when it decides to colour
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const slug = line.slice(0, tab).trim(), label = line.slice(tab + 1).trim();
    if (!/^[A-Za-z0-9][\w.:@+\/-]*$/.test(slug) || !label) continue;
    out.push(slug);
  }
  return [...new Set(out)];
}

/** prime-agent prints a table: provider, model, then sizes. Only the chosen provider's rows. */
export function parsePrimeModels(text: string, provider: string): string[] {
  return text.split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2 && c[0] === provider).map((c) => c[1]);
}

/** Codex prints its catalog as JSON; the models marked for listing, in its order. */
export function parseCodexModels(json: string): string[] {
  try { return (JSON.parse(json).models as any[]).filter((m) => m && m.visibility === "list" && typeof m.slug === "string").map((m) => m.slug); } catch { return []; }
}

/** Fallback for CLI versions without an SDK model catalog: read aliases from the installed tool's --model help. */
export function parseClaudeModelAliases(help: string): string[] {
  const lines = help.split("\n"), at = lines.findIndex((l) => l.includes("--model <model>"));
  if (at < 0) return [];
  const first = lines[at].slice(lines[at].indexOf("--model <model>") + "--model <model>".length);
  const description: string[] = [];
  for (const line of [first, ...lines.slice(at + 1)]) {
    if (/^\s{0,8}-\w/.test(line) || !line.trim()) break;       // the next option, or a blank line, ends it
    description.push(line);
  }
  return [...new Set([...description.join(" ").matchAll(/'([a-z][a-z0-9.-]{1,30})'/g)].map((m) => m[1]))];
}

/** One command's outcome, so a model list that fails can say why instead of looking empty. `status: null` means it did not finish (timeout or could not start). */
export interface CommandRun { stdout: string; stderr: string; status: number | null }
/** A runner takes a command and an optional stdin payload; tests pass a plain string, the device passes what the tool actually printed. */
export type ModelRunner = (cmd: string[], input?: string) => string | CommandRun;

/** Where one tool's model list came from, or why there is none. Kept beside the list so the Devices page can explain an empty dropdown. */
export interface ModelSource { source: string; found: number; at: number; error?: string }
export interface ModelCatalog { models: Record<string, string[]>; info: Record<string, ModelSource> }

const asRun = (r: string | CommandRun): CommandRun => (typeof r === "string" ? { stdout: r, stderr: "", status: 0 } : r);
const oneLine = (s: string) => s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
/** The reason a model list is not there, in terms a person can act on. Tool stderr can hold paths, tokens or account details, so it is never repeated. */
const whyNoModels = (cmd: string, r: CommandRun): string => r.status === null ? `${cmd} did not finish (it timed out or could not start)` : r.status !== 0 ? `${cmd} exited ${r.status}` : `${cmd} printed no models`;

/** Claude Code's SDK initialization lists the models the account may use, without a prompt or an inference call. */
const CLAUDE_INIT_ID = "fleet-model-discovery";
const CLAUDE_INIT_CMD = ["claude", "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json"];
const CLAUDE_INIT_INPUT = JSON.stringify({ type: "control_request", request_id: CLAUDE_INIT_ID, request: { subtype: "initialize" } }) + "\n";

/** Only `models[].value` is kept from the initialization response: account and other init fields are never stored or shown. */
export function parseClaudeInitModels(stdout: string, requestId = CLAUDE_INIT_ID): string[] {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "control_response") continue;
    if ((o.request_id ?? o.response?.request_id) !== requestId) continue;       // a different request's answer is not ours
    if (o.response?.subtype !== "success") continue;
    const models = o.response?.response?.models ?? o.response?.models;
    if (!Array.isArray(models)) continue;
    const values = models.map((m: any) => m?.value).filter((v: any): v is string => typeof v === "string" && v.length > 0);
    if (values.length) return [...new Set(values)];
  }
  return [];
}

/** Tool catalog commands; Claude uses SDK initialization first. Hermes's provider catalog has its own guarded probe below. */
export const MODEL_COMMANDS: Record<string, { source: string; commands: string[][] }> = {
  claude: { source: "claude --help's --model aliases (aliases only, not a full account model list)", commands: [["claude", "--help"]] },
  opencode: { source: "opencode models", commands: [["opencode", "models"]] },
  prime: { source: "prime-agent model list opencode-go", commands: [["prime-agent", "model", "list", "opencode-go"]] },
  codex: { source: "codex debug models", commands: [["codex", "debug", "models"]] },
  antigravity: { source: "agy models", commands: [["agy", "models"]] },
};

/** One tool's list, plus the reason when it is empty. A command that fails or prints nothing is reported, never silently shown as "no models". */
function probeModels(h: { id: string; label: string }, run: ModelRunner, at: number): { models: string[]; info: ModelSource } {
  const id = h.id, meta = MODEL_COMMANDS[id];
  const failed = (source: string, error: string) => ({ models: [], info: { source, found: 0, at, error } });
  if (!meta) return failed(h.label, `${h.label} has no model list command in this fleet version; type a model name instead`);
  const cmd = meta.commands[0].join(" ");
  if (id === "claude") {
    // Primary: the SDK initialization response lists this account's available models. No prompt and no inference request is sent.
    const initCmd = CLAUDE_INIT_CMD.join(" ");
    const init = asRun(run(CLAUDE_INIT_CMD, CLAUDE_INIT_INPUT));
    const models = init.status === 0 ? parseClaudeInitModels(init.stdout) : [];
    if (models.length) return { models, info: { source: "Claude Code SDK initialization (available models)", found: models.length, at } };
    const initWhy = init.status !== 0 ? whyNoModels(initCmd, init) : `${initCmd} listed no models`;
    // Fallback: the aliases named by the installed tool's own --model help (never a hardcoded list).
    const help = asRun(run(meta.commands[0]));
    const aliases = help.status === 0 ? parseClaudeModelAliases(help.stdout) : [];
    return aliases.length
      ? { models: aliases, info: { source: `${meta.source}; SDK initialization did not list models`, found: aliases.length, at } }
      : failed(meta.source, `${initWhy}; ${cmd} named no aliases either`);
  }
  if (id === "prime") {
    const r = asRun(run(meta.commands[0]));
    if (r.status !== 0) return failed(meta.source, whyNoModels(cmd, r));     // a partial table from a failed run is not trusted
    const models = parsePrimeModels(`${r.stdout}\n${r.stderr}`, "opencode-go");          // its table is printed on stderr
    if (!models.length) return failed(meta.source, whyNoModels(cmd, r));
    return { models, info: { source: meta.source, found: models.length, at } };
  }
  if (id === "codex") {
    const r = asRun(run(meta.commands[0]));
    if (r.status !== 0) return failed(meta.source, whyNoModels(cmd, r));
    const models = parseCodexModels(r.stdout);
    if (!models.length && !/^\s*\{/.test(r.stdout)) return failed(meta.source, `${cmd} did not print the catalog it lists`);
    return { models, info: { source: meta.source, found: models.length, at } };
  }
  if (id === "antigravity") {
    const r = asRun(run(meta.commands[0]));
    // Its fetch note is one line with no tab, so it never becomes a model; a failed run is still reported, never half-read.
    if (r.status !== 0) return failed(meta.source, whyNoModels(cmd, r));
    const models = parseAgyModels(`${r.stdout}\n${r.stderr}`);
    if (!models.length) return failed(meta.source, whyNoModels(cmd, r));
    return { models, info: { source: meta.source, found: models.length, at } };
  }
  const r = asRun(run(meta.commands[0]));
  if (r.status !== 0) return failed(meta.source, whyNoModels(cmd, r));        // a partial list from a failed run is not trusted
  const models = parseOpencodeModels(r.stdout);
  if (!models.length) return failed(meta.source, whyNoModels(cmd, r));
  return { models, info: { source: meta.source, found: models.length, at } };
}

/** The model lists are slow to read and rarely change. Kept for ten minutes, and re-read at once when the set of installed tools, or a tool program itself, changes: a cache keyed only by time would keep hiding a tool installed a minute ago. A list that failed is retried after a minute, so signing a tool in does not leave the old error on screen for ten. */
export const MODEL_CACHE_MS = 10 * 60_000;
export const MODEL_ERROR_CACHE_MS = 60_000;
let modelCache: { key: string; at: number; ttl: number; value: ModelCatalog } | null = null;

export function discoverModels(have: Set<string>, run: ModelRunner = (cmd, input) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 20_000, input, env: { ...process.env, PATH: pathWithTools() } });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: typeof r.status === "number" ? r.status : null };
}, opts: { refresh?: boolean; now?: number; key?: string } = {}): ModelCatalog {
  const at = opts.now ?? Date.now();
  const key = `${[...have].sort().join(",")}|${opts.key ?? ""}`;          // the key includes the installed tools, not just the clock
  if (!opts.refresh && modelCache && modelCache.key === key && at - modelCache.at < modelCache.ttl) return modelCache.value;
  const value: ModelCatalog = { models: {}, info: {} };
  // Registry order, so the lists and the explanation beside them keep a stable order.
  for (const h of HARNESSES) {
    if (!have.has(h.id) || h.model === "none") continue;
    let probe: { models: string[]; info: ModelSource };
    try { probe = probeModels(h, run, at); }
    catch { probe = { models: [], info: { source: MODEL_COMMANDS[h.id]?.source ?? h.label, found: 0, at, error: "could not run the model discovery command" } }; }
    value.models[h.id] = [...new Set(probe.models)];
    value.info[h.id] = { ...probe.info, found: value.models[h.id].length };
  }
  // A failure is worth retrying soon: the fix (signing in, a login, a config change) is often a minute away.
  const ttl = Object.values(value.info).some((i) => i.error) ? MODEL_ERROR_CACHE_MS : MODEL_CACHE_MS;
  modelCache = { key, at, ttl, value };
  return value;
}

/** Just the lists, for callers that do not show the explanation. */
export function collectModels(have: Set<string>, run?: ModelRunner, opts?: { refresh?: boolean; now?: number; key?: string }): Record<string, string[]> {
  return discoverModels(have, run, opts).models;
}

/** Hermes names its configured default model and provider in JSON: {"default":"anthropic/claude-opus-4.6","provider":"auto",...}. */
export interface HermesConfig { model: string; provider: string }
export function parseHermesConfig(json: string): HermesConfig {
  try {
    const o = JSON.parse(json);
    return {
      model: typeof o?.default === "string" ? o.default.trim() : "",
      provider: typeof o?.provider === "string" ? o.provider.trim() : "",
    };
  } catch { return { model: "", provider: "" }; }
}

/** Hermes has no supported model-list command. When its installed tree is present, its own Python can print the native
 * ids of the configured provider only, offline and without a model call. Ids are never rewritten: an id that is bare
 * stays bare, and OpenRouter's own provider/model ids stay as they are. */
const HERMES_CATALOG_SCRIPT = [
  "import sys, json",
  "from hermes_cli.models import _PROVIDER_MODELS as M, OPENROUTER_MODELS as O",
  "p = sys.argv[1]",
  "print(json.dumps([m[0] for m in O] if p == 'openrouter' else M.get(p, [])))",
].join("\n");
/** Hermes resolves "auto" itself. Only a provider name is read back; nothing else from the call is used. */
const HERMES_PROVIDER_SCRIPT = "import sys, json\nfrom hermes_cli.models import detect_provider_for_model\nprint(json.dumps(detect_provider_for_model(sys.argv[1])))";
const HERMES_DEFAULT_ONLY = "hermes config get model --json (the configured default only; Hermes has no model list command)";
const nativeModelId = (m: unknown): m is string => typeof m === "string" && /^[A-Za-z0-9][\w.:@+\/-]*$/.test(m) && !/\s/.test(m);
let hermesCache: { key: string; at: number; ttl: number; value: { models: string[]; info: ModelSource } } | null = null;

/** The model choices offered for a Hermes connector: the exact configured default first, then the native ids of its
 * configured provider. An unresolved "auto" or an unknown provider gets the default alone, clearly labelled. */
export function discoverHermesModels(run: ModelRunner = (cmd, input) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 20_000, input, env: { ...process.env, PATH: pathWithTools() } });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: typeof r.status === "number" ? r.status : null };
}, opts: { refresh?: boolean; now?: number; key?: string } = {}): { models: string[]; info: ModelSource } {
  const at = opts.now ?? Date.now(), key = opts.key ?? "";
  if (!opts.refresh && hermesCache && hermesCache.key === key && at - hermesCache.at < hermesCache.ttl) return hermesCache.value;
  const cfgRun = asRun(run(["hermes", "config", "get", "model", "--json"]));
  const cfg = cfgRun.status === 0 ? parseHermesConfig(cfgRun.stdout) : { model: "", provider: "" };
  const configured = cfg.model && nativeModelId(cfg.model) ? [cfg.model] : [];
  let models: string[] = [], source = HERMES_DEFAULT_ONLY, note = "";

  const where = asRun(run(["hermes", "config", "path"]));
  const configPath = where.status === 0 ? oneLine(where.stdout) : "";
  const python = configPath ? join(dirname(configPath), "hermes-agent", "venv", "bin", "python") : "";
  const canReadCatalog = !!python && existsSync(python);

  let provider = cfg.provider;
  if (provider === "auto" && configured.length && canReadCatalog) {
    const resolved = asRun(run([python, "-c", HERMES_PROVIDER_SCRIPT, cfg.model]));
    let name = "";
    try {
      const parsed = JSON.parse(resolved.stdout);
      name = typeof parsed === "string" ? parsed : Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : "";
    } catch {}
    provider = /^[A-Za-z0-9][\w.-]*$/.test(name) ? name : "";
    if (!provider) note = 'the configured provider is "auto" and it could not be resolved safely';
  }
  if (provider && canReadCatalog) {
    const cat = asRun(run([python, "-c", HERMES_CATALOG_SCRIPT, provider]));
    if (cat.status === 0) {
      try {
        const parsed = JSON.parse(cat.stdout);
        if (Array.isArray(parsed)) models = parsed.filter(nativeModelId);
      } catch {}
    }
    if (models.length) source = `Hermes's own catalog for provider ${provider} (read offline with its Python, no model call)`;
    else note = `Hermes has no offline catalog for provider ${provider}`;
  } else if (!provider) {
    if (!note) note = "the configured provider is not known";
  }

  const all = [...new Set([...configured, ...models])].slice(0, 400);
  if (note) source = configured.length ? `${HERMES_DEFAULT_ONLY}; ${note}`.slice(0, 200) : HERMES_DEFAULT_ONLY;
  const error = !all.length ? (cfgRun.status === null ? "hermes config get model did not finish (it timed out or could not start)" : `hermes config get model --json exited ${cfgRun.status}`) : undefined;
  const value = { models: all, info: { source, found: all.length, at, ...(error ? { error } : {}) } };
  const ttl = error ? MODEL_ERROR_CACHE_MS : MODEL_CACHE_MS;
  hermesCache = { key, at, ttl, value };
  return value;
}


/** The tailnet address if tailscale printed one, otherwise loopback; with the reason, so the person can judge. */
export function pickHost(tailscaleOutput: string): { host: string; reason: string } {
  const ip = tailscaleOutput.trim().split("\n")[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { host: ip, reason: "the Tailscale address of this machine, so your other devices can reach it" };
  return { host: "127.0.0.1", reason: "only this machine can reach it (Tailscale was not found); use --host <ip> to serve other devices" };
}

/** The `fleet` command: a tiny script holding bun's full path, so it works in any shell. */
export function launcherScript(bun: string, script: string): string {
  return `#!/bin/sh\nexec "${bun}" "${script}" "$@"\n`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A macOS login item that keeps one agent running. */
export function launchdPlist(o: { label: string; bun: string; script: string; name: string; args?: string[]; home: string; log: string }): string {
  const path = [dirname(o.bun), `${homedir()}/.opencode/bin`, `${homedir()}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(o.label)}</string>
<key>ProgramArguments</key><array><string>${xml(o.bun)}</string><string>${xml(o.script)}</string>${(o.args ?? ["run", o.name]).map((x) => `<string>${xml(x)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>FLEET_HOME</key><string>${xml(o.home)}</string><key>PATH</key><string>${xml(path)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(o.log)}</string>
<key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict></plist>
`;
}

/** What to run on someone else's device. The token appears once. */
export function joinLines(hubUrl: string, token: string, o: { name: string; harness: Harness; permissions: Permissions }): string[] {
  return [
    "On the other device (it needs bun), run these two lines:",
    `  curl -fsSL ${hubUrl}/fleet.ts -o fleet.ts`,
    `  bun fleet.ts join ${hubUrl} ${token} --name ${o.name} --harness ${o.harness} --dir <the folder it works in> --permissions ${o.permissions}`,
    "The token is shown once. Keep it private.",
  ];
}

// ---------- files ----------

const home = () => process.env.FLEET_HOME ?? join(homedir(), ".fleet");
const dirs = () => ({ home: home(), agents: join(home(), "agents"), logs: join(home(), "logs"), run: join(home(), "run"), state: join(home(), "state") });
function ensureDirs() { for (const d of Object.values(dirs())) mkdirSync(d, { recursive: true }); }
function writePrivate(file: string, data: string) { writeFileSync(file, data, { mode: 0o600 }); chmodSync(file, 0o600); }
const agentFile = (name: string) => join(dirs().agents, `${name}.json`);
const pidFile = (name: string) => join(dirs().run, `${name}.pid`);
const logFile = (name: string) => join(dirs().logs, `${name}.log`);
const helperPath = () => process.env.FLEET_HELPER ?? join(home(), "helper.ts");
const selfPath = () => import.meta.path;

/** A failure the person should read. The device daemon turns exits into errors it can report instead of dying. */
export class FleetError extends Error {}
let dieThrows = false;
function die(msg: string): never { if (dieThrows) throw new FleetError(msg); console.error(msg); process.exit(1); }
const loadAgent = (name: string): AgentConfig => existsSync(agentFile(name)) ? JSON.parse(readFileSync(agentFile(name), "utf8")) : die(`No agent named ${name} on this device. See: fleet ls`);
const listAgents = (): AgentConfig[] => existsSync(dirs().agents) ? readdirSync(dirs().agents).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dirs().agents, f), "utf8"))) : [];
const loadLogin = (): { hubUrl: string; humanToken: string } | null => existsSync(join(home(), "login.json")) ? JSON.parse(readFileSync(join(home(), "login.json"), "utf8")) : null;
const needLogin = () => loadLogin() ?? die("Not signed in. Run: fleet login <hub-url> <human-token>");
const clean = (u: string) => u.replace(/\/$/, "");

async function hubFetch(path: string, init: RequestInit = {}) {
  const l = needLogin();
  return fetch(`${l.hubUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${l.humanToken}`, "content-type": "application/json", ...(init.headers ?? {}) } });
}

// ---------- processes ----------

const pathWithTools = () => [dirname(process.execPath), `${homedir()}/.opencode/bin`, `${homedir()}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? ""].join(":");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runningPid = (name: string): number | null => {
  if (!existsSync(pidFile(name))) return null;
  const pid = Number(readFileSync(pidFile(name), "utf8"));
  return pid && alive(pid) ? pid : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startAgent(name: string): number {
  const existing = runningPid(name);
  if (existing) return existing;
  ensureDirs();
  const out = openSync(logFile(name), "a");
  const child = spawn(process.execPath, [selfPath(), ...(name === HUB ? ["hub", "run"] : name === DEVICE ? ["device", "run"] : ["run", name])], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, FLEET_HOME: home(), PATH: pathWithTools() } });
  child.unref();
  writeFileSync(pidFile(name), String(child.pid));
  return child.pid!;
}

async function stopAgent(name: string): Promise<boolean> {
  const pid = runningPid(name);
  if (!pid) return false;
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }   // the whole group: the runner and its helper
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  if (alive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
  rmSync(pidFile(name), { force: true });
  return true;
}

function helperEnv(cfg: AgentConfig): Record<string, string> {
  return {
    ...(process.env as Record<string, string>), PATH: pathWithTools(),
    FLEET_URL: cfg.hubUrl, FLEET_TOKEN: cfg.token, FLEET_HARNESS: cfg.harness, FLEET_WORKDIR: cfg.workdir,
    ...(cfg.project?{FLEET_PROJECT:cfg.project,FLEET_BRANCH:cfg.branch!,FLEET_BASE:cfg.base!}:{}),
    FLEET_STATE_DIR: dirs().state, FLEET_EXTRA_ARGS: extraArgsFor(cfg.harness, cfg.permissions).join(" "),
    ...(cfg.model ? { FLEET_MODEL: cfg.model } : {}), ...(cfg.provider ? { FLEET_PROVIDER: cfg.provider } : {}),
    ...(cfg.session ? { FLEET_SESSION_ID: cfg.session } : {}),
    ...(cfg.runCmd ? { FLEET_RUN_CMD: cfg.runCmd } : {}), ...(cfg.resumeCmd ? { FLEET_RESUME_CMD: cfg.resumeCmd } : {}),
  };
}

/** Runs the helper for one agent in the foreground. This is what the background start and the login service call. */
function runAgent(name: string): never {
  const cfg = loadAgent(name);
  ensureDirs();
  writeFileSync(pidFile(name), String(process.pid));
  const child = spawn(process.execPath, [helperPath()], { stdio: "inherit", env: helperEnv(cfg) });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill("SIGTERM"));
  child.on("exit", (code) => { rmSync(pidFile(name), { force: true }); process.exit(code ?? 0); });
  return undefined as never;
}

// ---------- the hub on this machine ----------

export interface HubConfig { owner: string; host: string; port: number; dataDir: string; repo: string }
const HUB = "_hub";
const DEVICE = "_device";                                   // not a valid agent name, so it never collides with one
const hubFile = () => join(home(), "hub.json");
const loadHub = (): HubConfig | null => existsSync(hubFile()) ? JSON.parse(readFileSync(hubFile(), "utf8")) : null;
const needHub = () => loadHub() ?? die("The hub is not set up on this machine. Run: fleet hub init");
const hubUrlOf = (c: HubConfig) => `http://${c.host}:${c.port}`;
const hubTokenFile = (c: HubConfig) => join(c.dataDir, "human-token");
const repoDir = () => resolve(dirname(selfPath()), "..");
const hasRepo = (dir: string) => existsSync(join(dir, "src", "server.ts"));

async function hubReady(c: HubConfig, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(`${hubUrlOf(c)}/skills.md`)).ok) return true; } catch {}
    if (!runningPid(HUB)) return false;
    await sleep(250);
  }
  return false;
}

/** The master token: read from the data folder, or generated there on first use. */
function ensureHubToken(c: HubConfig): string {
  const file = hubTokenFile(c);
  const saved = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (saved) return saved;
  const token = randomBytes(24).toString("hex");
  mkdirSync(c.dataDir, { recursive: true });
  writePrivate(file, `${token}\n`);
  return token;
}

/** Runs the hub in the foreground. The background start and the login service both call this. */
function runHub(): never {
  const c = needHub();
  ensureDirs();
  writeFileSync(pidFile(HUB), String(process.pid));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: pathWithTools(), HUB_HOST: c.host, HUB_PORT: String(c.port), HUB_DB: join(c.dataDir, "fleet.db"), HUB_OWNER: c.owner };
  env.HUB_HUMAN_TOKEN = ensureHubToken(c);                       // the saved token file is the source of truth for a hub fleet manages (a stray .env must not override it)
  const child = spawn(process.execPath, [join(c.repo, "src", "server.ts")], { cwd: c.repo, stdio: "inherit", env });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill("SIGTERM"));
  child.on("exit", (code) => { rmSync(pidFile(HUB), { force: true }); process.exit(code ?? 0); });
  return undefined as never;
}

async function hubInit(a: ReturnType<typeof parseArgs>) {
  const existing = loadHub();
  if (existing) die(`The hub is already set up on this machine (${hubUrlOf(existing)}, data in ${existing.dataDir}). See: fleet hub status | start | token | set`);
  const repo = repoDir();
  if (!hasRepo(repo)) die(`The hub's source was not found next to this command (${repo}). Run this from a checkout of the agent-fleet repository: git clone <repo> && cd agent-fleet && bun cli/fleet.ts hub init`);
  if (!existsSync(join(repo, "node_modules"))) {
    console.log("Installing the hub's dependencies (bun install)...");
    if (spawnSync(process.execPath, ["install"], { cwd: repo, stdio: "inherit" }).status !== 0) die("bun install failed.");
  }
  const owner = (a.flags.owner as string) ?? process.env.USER ?? die("Pass --owner <your name>.");
  const picked = typeof a.flags.host === "string" ? { host: a.flags.host, reason: "as you asked" } : pickHost(spawnSync("tailscale", ["ip", "-4"], { encoding: "utf8" }).stdout ?? "");
  const port = Number(a.flags.port ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) die("--port must be a number between 1 and 65535.");
  const dataDir = resolve((a.flags.dir as string) ?? join(home(), "hub-data"));
  mkdirSync(dataDir, { recursive: true });
  ensureDirs();
  const cfg: HubConfig = { owner, host: picked.host, port, dataDir, repo };
  writeFileSync(hubFile(), JSON.stringify(cfg, null, 2));
  ensureHubToken(cfg);
  console.log(`Starting the hub on ${picked.host}:${port}: ${picked.reason}.`);
  startAgent(HUB);
  if (!(await hubReady(cfg))) { rmSync(hubFile(), { force: true }); await stopAgent(HUB); die(`The hub did not come up. Last log lines:\n${spawnSync("tail", ["-n", "10", logFile(HUB)], { encoding: "utf8" }).stdout}\nIf the port is taken, try --port. Nothing was kept; run the init again.`); }
  const token = readFileSync(hubTokenFile(cfg), "utf8").trim();
  writePrivate(join(home(), "login.json"), JSON.stringify({ hubUrl: hubUrlOf(cfg), humanToken: token }));
  let launcher = "";
  if (!a.flags["no-launcher"]) {
    const dest = join(homedir(), ".local", "bin", "fleet");
    if (existsSync(dest)) launcher = `A fleet command already exists at ${dest}; left as it is.`;
    else { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, launcherScript(process.execPath, selfPath()), { mode: 0o755 }); chmodSync(dest, 0o755); launcher = `Installed the fleet command at ${dest}${(process.env.PATH ?? "").split(":").includes(dirname(dest)) ? "" : ` (add ${dirname(dest)} to your PATH to use it from anywhere)`}.`; }
  }
  const url = hubUrlOf(cfg);
  console.log(`
Fleet is running.

  Web UI:        ${url}/
  Master token:  ${token}
                 This is the password for the web UI and for \`fleet login\`. Keep it private.
                 It is saved in ${hubTokenFile(cfg)}; show it again with: fleet hub token
  Owner:         ${owner}   (agents owned by anyone else are treated as outside agents)
  Data:          ${dataDir}
${launcher ? `\n  ${launcher}\n` : ""}
This machine is already signed in. Next:
  1. Add an agent here:       fleet agent add my-first-agent --harness claude --dir ~/some-folder
  2. Add another device:      on that device run  curl -fsSL ${url}/install.sh | sh   then  fleet login ${url} <master token>
  3. Start the hub at login:  fleet hub service install      (macOS)
  4. A friend's agent:        fleet agent add their-agent --owner <their name> --print-prompt
${picked.host === "127.0.0.1" ? "\nNote: only this machine can reach the hub right now. To serve other devices: fleet hub set --host <this machine's tailnet or LAN address>\n" : ""}Read the README's "Use" section for the day-to-day commands.`);
}

async function hubCmd(a: ReturnType<typeof parseArgs>) {
  const sub = a._[1];
  switch (sub) {
    case "init": return hubInit(a);
    case "run": return runHub();
    case "start": {
      const c = needHub();
      if (!hasRepo(c.repo)) die(`The hub's source is missing at ${c.repo}.`);
      const pid = startAgent(HUB);
      return console.log((await hubReady(c)) ? `The hub is running (${pid}) at ${hubUrlOf(c)}.` : `Started (${pid}) but it is not answering yet. See: fleet hub logs`);
    }
    case "stop": needHub(); return console.log((await stopAgent(HUB)) ? "Stopped the hub. Agents keep their sessions and reconnect when it is back." : "The hub was not running.");
    case "restart": { const c = needHub(); await stopAgent(HUB); startAgent(HUB); return console.log((await hubReady(c)) ? `The hub is running at ${hubUrlOf(c)}.` : "Started but not answering yet. See: fleet hub logs"); }
    case "status": {
      const c = needHub(), pid = runningPid(HUB);
      console.log(`${pid ? `running (${pid})` : "stopped"}  ${c.host}:${c.port}  owner ${c.owner}  data ${c.dataDir}`);
      if (pid) console.log(`web UI ${hubUrlOf(c)}/`);
      return;
    }
    case "token": return console.log(readFileSync(hubTokenFile(needHub()), "utf8").trim());
    case "logs": {
      needHub();
      return void spawnSync("tail", a.flags.f || a.flags.follow ? ["-n", "40", "-f", logFile(HUB)] : ["-n", "40", logFile(HUB)], { stdio: "inherit" });
    }
    case "set": {
      const c = needHub();
      if (typeof a.flags.host === "string") c.host = a.flags.host;
      if (a.flags.port !== undefined) c.port = Number(a.flags.port);
      if (typeof a.flags.owner === "string") c.owner = a.flags.owner;
      if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) die("--port must be a number between 1 and 65535.");
      writeFileSync(hubFile(), JSON.stringify(c, null, 2));
      const login = loadLogin();
      if (login) writePrivate(join(home(), "login.json"), JSON.stringify({ ...login, hubUrl: hubUrlOf(c) }));
      await stopAgent(HUB); startAgent(HUB);
      console.log((await hubReady(c)) ? `Updated and restarted: ${hubUrlOf(c)}, owner ${c.owner}. Agents set up with the old address need re-adding or editing.` : "Updated, but the hub is not answering. See: fleet hub logs");
      return;
    }
    case "service":
      if (a._[2] === "install") return hubServiceInstall();
      if (a._[2] === "uninstall") return serviceUninstall(HUB, false, "dev.fleet.hub", join(homedir(), "Library", "LaunchAgents", "dev.fleet.hub.plist"));
      return die("Usage: fleet hub service install|uninstall");
    default: return die("Usage: fleet hub init | status | start | stop | restart | logs [-f] | token | set [--host H --port P --owner N] | service install|uninstall");
  }
}

function hubServiceInstall() {
  if (process.platform !== "darwin") die("Login services are supported on macOS only for now. On Linux, run `fleet hub start` from a systemd user unit or cron @reboot.");
  needHub();
  ensureDirs();
  const label = "dev.fleet.hub", file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, launchdPlist({ label, bun: process.execPath, script: selfPath(), name: HUB, args: ["hub", "run"], home: home(), log: logFile(HUB) }));
  if (spawnSync("plutil", ["-lint", file]).status !== 0) die(`Wrote an invalid ${file}.`);
  const uid = String(process.getuid?.() ?? 501);
  spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`]);
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, file]);
  if (r.status !== 0) die(`launchctl could not load the service: ${r.stderr?.toString().trim()}`);
  console.log("The hub will now start at login and restart if it stops. If one is already running from `fleet hub start`, stop it first: fleet hub stop. Remove with: fleet hub service uninstall");
}

// ---------- this machine as a device the hub can ask to start agents ----------

interface DeviceConfig { hubUrl: string; token: string; name: string; roots: string[]; /** Rises on every local change, so the hub can tell an old report from a new one. */ rev?: number }
const deviceFile = () => join(home(), "device.json");
const confirmedFile = () => join(home(), "device-confirmed.json");
const pendingFile = () => join(home(), "device-pending.json");
const loadDevice = (): DeviceConfig | null => existsSync(deviceFile()) ? JSON.parse(readFileSync(deviceFile(), "utf8")) : null;
/** Writes the device config in one step (readers never see half a file) and bumps its revision, which the hub uses to ignore reports older than what it has. */
function saveDevice(c: DeviceConfig) {
  c.rev = Math.max(c.rev ?? 0, (loadDevice()?.rev ?? 0) + 1);
  const file = deviceFile(), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
const needDevice = () => loadDevice() ?? die("This machine is not enrolled as a device. In the web UI open Devices, add one, and run the command it shows.");
const readJson = <T,>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };

/** The sessions a device offers for import: those of the harnesses it can read, in its allowed folders and one or two levels below. */
export function collectSessions(roots: string[], claudeHome = process.env.FLEET_CLAUDE_HOME ?? homedir(), codexHome = process.env.FLEET_CODEX_HOME ?? homedir()) {
  const dirs = new Set<string>();
  const addChildren = (dir: string, depth: number) => {
    if (dirs.size >= 300) return;
    dirs.add(dir);
    if (depth >= 2) return;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") addChildren(join(dir, e.name), depth + 1);
  };
  for (const r of roots) addChildren(r, 0);
  const found: { harness: string; id: string; dir: string; modified: number; preview: string }[] = [];
  for (const dir of dirs) for (const s of listClaudeSessions(dir, claudeHome).slice(0, 5)) found.push({ harness: "claude", id: s.id, dir, modified: s.modified, preview: s.preview });
  for (const s of allCodexSessions(codexHome)) if (dirs.has(s.cwd)) found.push({ harness: "codex", id: s.id, dir: s.cwd, modified: s.modified, preview: s.preview });
  return found.sort((a, b) => b.modified - a.modified).slice(0, 300);
}

const realOrNull = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** A tool program's size and modification time, so a model list is re-read when the tool is upgraded in place. */
const toolStamp = (path: string | null): string => {
  if (!path) return "-";
  try { const s = statSync(path); return `${s.size}:${s.mtimeMs}`; } catch { return "?"; }
};

async function deviceReport(cfg: DeviceConfig, opts: { models?: boolean } = {}): Promise<Response> {
  const which = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { env: { ...process.env, PATH: pathWithTools() } }).stdout.toString().trim() || null;
  const harnesses = detectHarnesses(which);
  // Which tools are installed, and which programs, is part of the cache key: installing a tool or upgrading one shows its models at the next report.
  // Enrolling skips the lists: the daemon reports them a moment later, and nothing should wait for a slow tool before the device starts.
  let catalog: ModelCatalog = opts.models === false ? { models: {}, info: {} } : discoverModels(new Set(harnesses.map((h) => h.id)), undefined, { key: harnesses.map((h) => `${h.id}@${h.path ?? "-"}@${toolStamp(h.path)}`).join(",") });
  // Hermes is not a launch harness yet, but the custom connector form offers its models when it is installed here.
  const hermesPath = opts.models === false ? null : which("hermes");
  if (hermesPath) {
    const hermes = discoverHermesModels(undefined, { key: `${hermesPath}@${toolStamp(hermesPath)}` });
    catalog = { models: { ...catalog.models, hermes: hermes.models }, info: { ...catalog.info, hermes: hermes.info } };
  }
  // Subscription usage, measured here and cached for five minutes: a tool that is not installed is left out, and one
  // that cannot be measured says why, so the Usage tab never shows a made-up number. Enrolment skips it as well: the
  // daemon reports a moment later, and nothing should wait for a slow tool before the device starts.
  const usage = opts.models === false ? {} : collectUsage(new Set(harnesses.map((h) => h.id)));
  // Read the folders after the scan above, which can take seconds: a folder allowed while it ran must be in this report,
  // not only in the next one. The revision rides along so the hub can drop a report that is still older than what it has.
  const disk = loadDevice();
  const cur = disk && disk.hubUrl === cfg.hubUrl ? disk : cfg;
  return fetch(`${cfg.hubUrl}/device/report`, {
    method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ hostname: hostname(), harnesses, roots: cur.roots, rev: cur.rev ?? 0, models: catalog.models, modelInfo: catalog.info, usage, sessions: collectSessions(cur.roots) }),
  });
}

async function deviceEnroll(a: ReturnType<typeof parseArgs>) {
  const hubUrl = clean(a._[2] ?? ""), token = a._[3];
  if (!hubUrl || !token) die("Usage: fleet device enroll <hub-url> <device-token>   (the web UI's Devices page shows both)");
  const prev = loadDevice();
  const cfg: DeviceConfig = { hubUrl, token, name: (a.flags.name as string) ?? hostname(), roots: prev?.hubUrl === hubUrl ? prev.roots : [], rev: (prev?.rev ?? 0) + 1 };
  let res: Response;
  try { res = await deviceReport(cfg, { models: false }); } catch (e) { die(`Could not reach ${hubUrl}: ${(e as Error).message}`); }
  if (res.status === 401) die("The hub did not accept that device token. It is shown once: add the device again in the web UI if it was lost.");
  if (!res.ok) die(`The hub answered ${res.status}.`);
  ensureDirs();
  saveDevice(cfg);
  startAgent(DEVICE);
  console.log(`This machine is now a device on ${hubUrl}, and it is running.
The hub can start agents here only inside folders you allow, and only the harnesses installed here.
  1. Allow a folder:      fleet device allow <the folder your projects live in>   (nothing is allowed until you do;
                          add --create if it does not exist yet)
  2. Then in the web UI:  Devices → ${cfg.name} → Add agent
Agents that need the "open" permission wait for you to confirm them here: fleet device confirm
Stop it any time: fleet device stop. Remove it from the hub in the web UI (that also revokes the agents it started).`);
}

async function deviceCmd(a: ReturnType<typeof parseArgs>) {
  const sub = a._[1];
  switch (sub) {
    case "enroll": return deviceEnroll(a);
    case "run": return runDevice();
    case "start": { needDevice(); const pid = startAgent(DEVICE); return console.log(`The device is running (${pid}).`); }
    case "stop": return console.log((await stopAgent(DEVICE)) ? "Stopped the device. The hub can no longer start agents here until it is started again." : "The device was not running.");
    case "status": {
      const c = loadDevice();
      if (!c) return console.log("stopped: this machine is not enrolled as a device.");
      const pid = runningPid(DEVICE);
      return console.log(`${pid ? `running (${pid})` : "stopped"}  ${c.name} on ${c.hubUrl}\nallowed folders: ${c.roots.join(", ") || "none"}`);
    }
    case "logs": { needDevice(); return void spawnSync("tail", a.flags.f || a.flags.follow ? ["-n", "40", "-f", logFile(DEVICE)] : ["-n", "40", logFile(DEVICE)], { stdio: "inherit" }); }
    case "roots": { const c = needDevice(); return console.log(c.roots.length ? c.roots.join("\n") : "No folders are allowed. Allow one: fleet device allow <folder>"); }
    case "allow": {
      const c = needDevice(), given = a._[2] ?? die("Usage: fleet device allow <folder> [--create]   (the folder your projects live in, for example ~/coding)");
      const wanted = resolve(given.replace(/^~(?=\/|$)/, homedir()));
      if (!existsSync(wanted) && a.flags.create) mkdirSync(wanted, { recursive: true });
      const dir = realOrNull(wanted);
      if (!dir || !statSync(dir).isDirectory()) {
        const usual = ["coding", "code", "projects", "dev", "work", "src", "Documents", "Developer"].map((n) => join(homedir(), n)).filter((p) => existsSync(p));
        die(`${wanted} does not exist on this machine.\n  Create it and allow it:  fleet device allow ${given} --create\n${usual.length ? `  Or allow a folder that is already here: ${usual.join(", ")}` : "  Or pass the folder your projects live in."}`);
      }
      if (dir === "/") die("Not allowing /: that would let the hub start agents anywhere on this machine. Allow a specific folder.");
      if (dir === realOrNull(homedir())) die("Not allowing your whole home folder: that is too broad. Allow the subfolder your projects live in, for example ~/coding.");
      if (!c.roots.includes(dir)) c.roots.push(dir);
      saveDevice(c);
      try { await deviceReport(c); } catch {}
      return console.log(`Allowed ${dir}. The hub can now start agents in it and in folders below it.`);
    }
    case "deny": {
      const c = needDevice(), given = a._[2] ?? die("Usage: fleet device deny <folder>");
      const dir = realOrNull(resolve(given.replace(/^~(?=\/|$)/, homedir()))) ?? resolve(given);
      c.roots = c.roots.filter((r) => r !== dir);
      saveDevice(c);
      try { await deviceReport(c); } catch {}
      return console.log(`No longer allowing ${dir}. Agents already running there keep running; stop them with fleet stop <name>.`);
    }
    case "confirm": {
      needDevice();
      const pending = readJson<{ id: string; agentName: string; harness: string; dir: string; permissions: string }[]>(pendingFile(), []);
      const want = a._[2];
      if (!want) {
        if (!pending.length) return console.log("Nothing is waiting for your confirmation.");
        console.log("Waiting for you to confirm (these start agents that can run anything on this machine):");
        for (const p of pending) console.log(`  ${p.id.slice(0, 8)}  ${p.agentName}  ${p.harness}  ${p.dir}  permissions ${p.permissions}`);
        return console.log("Confirm one with: fleet device confirm <id>");
      }
      const hit = pending.filter((p) => p.id.startsWith(want));
      if (hit.length !== 1) die(hit.length ? `${want} matches more than one request; use more of the id.` : `Nothing waiting matches ${want}. See: fleet device confirm`);
      writePrivate(confirmedFile(), JSON.stringify([...new Set([...readJson<string[]>(confirmedFile(), []), hit[0].id])]));
      return console.log(`Confirmed ${hit[0].agentName}. It starts within a couple of seconds.`);
    }
    default: return die("Usage: fleet device enroll <hub-url> <token> | allow <folder> | deny <folder> | roots | confirm [id] | status | start | stop | logs");
  }
}

/** The device daemon: waits for the hub, reports what this machine has, and starts agents the hub asks for, after checking each request itself. */
async function runDevice(): Promise<never> {
  dieThrows = true;
  ensureDirs();
  writeFileSync(pidFile(DEVICE), String(process.pid));
  const log = (l: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`);
  const announced = new Set<string>();
  let busy = false, again = false;
  let removed = false;

  const result = async (cfg: DeviceConfig, id: string, status: "done" | "failed" | "awaiting-confirmation", message: string) => {
    await fetch(`${cfg.hubUrl}/device/requests/${id}/result`, { method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify({ status, message }) });
  };

  const launch = async (cfg: DeviceConfig, r: { id: string; payload: any }) => {
    const p = r.payload, pending = readJson<any[]>(pendingFile(), []).filter((x) => x.id !== r.id);
    const fail = async (why: string) => { log(`refused ${p.agentName}: ${why}`); writeFileSync(pendingFile(), JSON.stringify(pending)); await result(cfg, r.id, "failed", why); };
    // The hub has checked all of this already; the device does not take its word for it.
    const dir = typeof p.dir === "string" ? realOrNull(p.dir) : null;
    const roots = cfg.roots.map((x) => realOrNull(x)).filter((x): x is string => !!x);
    if (!dir || !underRoots(dir, roots)) return fail(`${p.dir} is outside the folders this device allows`);
    const harness = normalizeHarness(p.harness);
    if (!harness) return fail("unknown harness");
    const have = detectHarnesses((bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { env: { ...process.env, PATH: pathWithTools() } }).stdout.toString().trim() || null);
    if (!have.some((h) => h.id === harness)) return fail(`${harness} is not installed on this machine`);
    if (!validName(p.agentName ?? "")) return fail("invalid agent name");
    if (p.permissions === "open" && !readJson<string[]>(confirmedFile(), []).includes(r.id)) {
      // An agent that can run anything starts only when someone at this machine says so.
      writeFileSync(pendingFile(), JSON.stringify([...pending, { id: r.id, agentName: p.agentName, harness, dir, permissions: p.permissions }]));
      if (!announced.has(r.id)) { announced.add(r.id); log(`${p.agentName} wants the open permission: waiting for: fleet device confirm ${r.id.slice(0, 8)}`); await result(cfg, r.id, "awaiting-confirmation", `waiting for someone at ${cfg.name} to run: fleet device confirm ${r.id.slice(0, 8)}`); }
      return;
    }
    try {
      const work=p.project?prepareWorktree(dir,p.agentName,cfg.hubUrl,p.token,{project:p.project,branch:p.branch,base:p.base}):undefined;
      await joinHere({ hubUrl: cfg.hubUrl, token: p.token, name: p.agentName, harness, dir:work?.dir??dir, ...(work?{canonical:{project:p.project,branch:work.branch,base:work.base}}:{}), model: p.model, provider: p.provider, permissions: p.permissions, start: true, runCmd: p.runCmd, resumeCmd: p.resumeCmd, session: p.session });
      writeFileSync(pendingFile(), JSON.stringify(pending));
      await result(cfg, r.id, "done", `${p.agentName} is running here`);
      log(`started ${p.agentName} (${harness}) in ${dir}`);
    } catch (e) {
      await fail((e as Error).message);
    }
  };

  const work = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        const cfg = loadDevice();
        if (!cfg) { log("device configuration is gone; stopping"); process.exit(0); }
        const res = await fetch(`${cfg.hubUrl}/device/pull`, { method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: "{}" });
        if (res.status === 401) { removed = true; log("the hub no longer accepts this device (it was removed). Stopping."); rmSync(pidFile(DEVICE), { force: true }); process.exit(0); }
        if (!res.ok) throw new Error(`pull failed: ${res.status}`);
        for (const r of ((await res.json()) as any).requests) if (r.kind === "launch") await launch(cfg, r);
      } while (again);
    } catch (e) { log(`error: ${(e as Error).message}`); }
    finally { busy = false; }
  };

  const reportNow = async () => { const cfg = loadDevice(); if (cfg) { try { const r = await deviceReport(cfg); if (r.status === 401) { log("the hub no longer accepts this device (it was removed). Stopping."); rmSync(pidFile(DEVICE), { force: true }); process.exit(0); } } catch (e) { log(`report failed: ${(e as Error).message}`); } } };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { rmSync(pidFile(DEVICE), { force: true }); process.exit(0); });

  setInterval(() => void reportNow().then(work), 60_000);
  setInterval(() => { if (readJson<any[]>(pendingFile(), []).length) void work(); }, 2000);     // a confirmation typed at the keyboard
  await reportNow();
  void work();
  log("device running");
  for (let backoff = 1000; !removed; ) {
    try {
      const cfg = loadDevice()!;
      const res = await fetch(`${cfg.hubUrl}/device/events`, { headers: { Authorization: `Bearer ${cfg.token}` } });
      if (res.status === 401) { log("the hub no longer accepts this device (it was removed). Stopping."); rmSync(pidFile(DEVICE), { force: true }); process.exit(0); }
      if (!res.ok || !res.body) throw new Error(`events failed: ${res.status}`);
      backoff = 1000;
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as any) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const ev = /event: (\w+)/.exec(buf.slice(0, i))?.[1];
          buf = buf.slice(i + 2);
          if (ev === "removed") { log("the hub removed this device. Stopping."); rmSync(pidFile(DEVICE), { force: true }); process.exit(0); }
          if (ev === "hello" || ev === "wake") void reportNow().then(work);
        }
      }
      throw new Error("event stream closed");
    } catch (e) {
      log(`${(e as Error).message}; reconnecting in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  return undefined as never;
}

// ---------- commands ----------

async function downloadHelper(hubUrl: string) {
  if (process.env.FLEET_HELPER) return;
  const res = await fetch(`${hubUrl}/helper.ts`);
  if (!res.ok) die(`Could not download the helper from ${hubUrl} (${res.status}). Is the address right?`);
  ensureDirs();
  writeFileSync(helperPath(), await res.text());
}

async function checkToken(hubUrl: string, token: string): Promise<boolean> {
  try { return (await fetch(`${hubUrl}/agent/pull`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).ok; } catch { return false; }
}

async function onlineOnHub(name: string): Promise<boolean | null> {
  if (!loadLogin()) return null;
  try {
    const s = await (await hubFetch("/api/state")).json();
    const a = s.agents.find((x: any) => x.name === name);
    return !!a && !!a.lastSeen && Date.now() - a.lastSeen < 45_000;
  } catch { return null; }
}

/** Refuses a session that cannot be adopted. Claude keeps sessions per folder, so one from another folder cannot be resumed here: say so now, not on the agent's first wake. */
function checkSession(harness: Harness, session: string, workdir: string, local: boolean) {
  const why = validateSession(harness, session);
  if (why) die(`Cannot adopt session ${session}: ${why}.`);
  if (local && harness === "claude" && !existsSync(join(claudeProjectDir(workdir), `${session}.jsonl`)))
    die(`Claude has no session ${session} for the folder ${workdir} (it keeps sessions per folder). List this folder's sessions with: fleet sessions --dir ${workdir}`);
  if (local && harness === "codex" && !listCodexSessions(workdir).some((s) => s.id === session))
    die(`Codex has no session ${session} that was started in ${workdir}. List this folder's sessions with: fleet sessions --dir ${workdir}`);
}

async function joinHere(o: { canonical?:CanonicalWork; hubUrl: string; token: string; name: string; harness: Harness; dir: string; model?: string; provider?: string; permissions: Permissions; start: boolean; runCmd?: string; resumeCmd?: string; session?: string }) {
  if (!validName(o.name)) die("Name must be 1-40 lowercase letters, digits or dashes.");
  extraArgsFor(o.harness, o.permissions);                                    // fail early on a bad combination
  if (harnessInfo(o.harness).model === "required" && !o.model) die(`${harnessInfo(o.harness).label} needs a model, for example --model ${harnessInfo(o.harness).modelExample}${o.harness === "opencode" ? " (list them with `opencode models`)" : o.harness === "prime" ? " (list them with `prime-agent model list opencode-go`)" : ""}`);
  if (o.harness === "custom" && !o.runCmd) die("A custom harness needs --run-cmd: the command that runs one turn, with {prompt} and {session} (and --resume-cmd to continue a session). Run `fleet install` for how to write it.");
  const workdir = resolve(o.dir);
  if (o.session) checkSession(o.harness, o.session, workdir, true);
  if (!existsSync(workdir)) die(`The folder ${workdir} does not exist. Create it, or pass --dir.`);
  if (!(await checkToken(o.hubUrl, o.token))) die("The hub did not accept that token. Check the address and token.");
  await downloadHelper(o.hubUrl);
  ensureDirs();
  const cfg: AgentConfig = { ...o.canonical, name: o.name, hubUrl: o.hubUrl, token: o.token, harness: o.harness, workdir, model: o.model, ...(o.harness === "prime" ? { provider: o.provider ?? "opencode-go" } : {}), ...(o.harness === "custom" ? { runCmd: o.runCmd, resumeCmd: o.resumeCmd } : {}), ...(o.session ? { session: o.session } : {}), permissions: o.permissions };
  if (o.harness === "custom" || o.harness === "codex" || harnessInfo(o.harness).unverified) {
    console.log(`Running the self-check (two short turns)${harnessInfo(o.harness).unverified ? `: ${harnessInfo(o.harness).label} support is new, so it proves itself before going online` : ""}...`);
    const r = spawnSync(process.execPath, [helperPath(), "check"], { env: helperEnv(cfg), stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) die("The self-check failed, so nothing was set up here. The token is still valid: fix the command and run the join again.");
    console.log("Self-check passed.");
  }
  writePrivate(agentFile(o.name), JSON.stringify(cfg, null, 2));
  console.log(`Set up ${o.name} (${o.harness}) in ${workdir}`);
  if (o.session) console.log(`It will continue session ${o.session}, so it remembers that conversation.`);
  console.log(permissionNote(o.harness, o.permissions));
  if (!o.start) { console.log(`Not started. Start it with: fleet start ${o.name}`); return; }
  await stopAgent(o.name);           // a helper still running under the old token or settings would otherwise be kept as it is
  startAgent(o.name);
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!runningPid(o.name)) die(`The helper stopped right away. See: fleet logs ${o.name}`);
    const on = await onlineOnHub(o.name);
    if (on) { console.log(`${o.name} is online. It wakes only when the hub has something for it.`); return; }
    if (on === null && i >= 3) { console.log(`${o.name} is running and the hub accepted its token.`); return; }
  }
  console.log(`${o.name} is running but the hub has not seen it yet. Check: fleet logs ${o.name}`);
}

function shq(s: string) { return `'${s.replace(/'/g, `'\\''`)}'`; }

async function agentAdd(a: ReturnType<typeof parseArgs>, existing = false) {
  const name = a._[2];
  if (!name || !validName(name)) die("Usage: fleet agent add <name> --harness claude|opencode|prime-agent|codex|antigravity|custom [--dir DIR] ...  (name: lowercase letters, digits, dashes)");
  const harness = normalizeHarness(a.flags.harness) ?? (a.flags["print-prompt"] ? "claude" : die(`--harness ${HARNESSES.map((h) => h.id === "prime" ? "prime-agent" : h.id).join("|")} is required.`));
  const permissions = ((a.flags.permissions as string) ?? "safe") as Permissions;
  if (!a.flags["print-prompt"]) try { extraArgsFor(harness, permissions); } catch (e) { die((e as Error).message); }
  const runCmd = typeof a.flags["run-cmd"] === "string" ? a.flags["run-cmd"] : undefined, resumeCmd = typeof a.flags["resume-cmd"] === "string" ? a.flags["resume-cmd"] : undefined;
  if (harness === "custom" && !runCmd && !a.flags["print-prompt"] && !a.flags["print-join"]) die("A custom harness needs --run-cmd (the command that runs one turn, with {prompt} and {session}). Or use --print-prompt and let the agent write it.");
  const session = typeof a.flags.session === "string" ? a.flags.session : undefined;
  if (session && !a.flags["print-prompt"]) checkSession(harness, session, resolve(typeof a.flags.dir === "string" ? a.flags.dir : process.cwd()), typeof a.flags.ssh !== "string");
  const model = a.flags.model as string | undefined;
  if (!a.flags["print-prompt"] && harnessInfo(harness).model === "required" && !model) die(`${harnessInfo(harness).label} needs --model, for example --model ${harnessInfo(harness).modelExample}${harness === "opencode" ? " (list them with `opencode models`)" : harness === "prime" ? " (list them with `prime-agent model list opencode-go`)" : ""}.`);
  const login = needLogin();
  const host = typeof a.flags.ssh === "string" ? a.flags.ssh : null;
  if (host && /localhost|127\.0\.0\.1/.test(login.hubUrl)) console.error(`Warning: ${login.hubUrl} is not reachable from ${host}. Sign in with an address both machines can reach.`);

  // An existing agent's token cannot be read back (only a hash is kept), so reconnecting issues a new one for the same agent.
  const res = existing
    ? await hubFetch(`/api/agents/${encodeURIComponent(name)}/token`, { method: "POST" })
    : await hubFetch("/api/agents", { method: "POST", body: JSON.stringify({ name, owner: a.flags.owner, device: host ?? hostname(), workspace: typeof a.flags.workspace === "string" ? a.flags.workspace : undefined }) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) die(`The hub refused: ${body.error ?? res.status}`);
  console.log(existing ? `Issued a new token for ${name} (owner ${body.owner}). The old token no longer works, and ${name} keeps its tasks and history.` : `Created ${name} on the hub (owner ${body.owner}).`);

  if (a.flags["print-prompt"]) { console.log("\nPaste this into the agent (it contains its token, shown once):\n"); console.log(installInstructions({ hubUrl: login.hubUrl, token: body.token, name })); return; }
  if (a.flags["print-join"]) { for (const l of joinLines(login.hubUrl, body.token, { name, harness, permissions })) console.log(l); return; }
  const dir = (a.flags.dir as string) ?? (host ? "~" : process.cwd());
  if (host) {
    const rdir = dir.startsWith("~") ? `"$HOME${dir.slice(1)}"` : shq(dir);
    const script = `mkdir -p ~/.fleet && curl -fsSL ${login.hubUrl}/fleet.ts -o ~/.fleet/fleet.ts && bun ~/.fleet/fleet.ts join ${login.hubUrl} - --name ${name} --harness ${harness} --dir ${rdir} --permissions ${permissions}${model ? ` --model ${shq(model)}` : ""}${a.flags["no-start"] ? " --no-start" : ""}`;
    console.log(`Setting it up on ${host}...`);
    const r = spawnSync("ssh", [host, `zsh -lc ${shq(script)}`], { input: `${body.token}\n`, stdio: ["pipe", "inherit", "inherit"] });
    if (r.status !== 0) die(`Setting up ${host} failed. The agent exists on the hub; remove it with: fleet agent rm ${name}`);
    return;
  }
  await joinHere({ hubUrl: login.hubUrl, token: body.token, name, harness, dir, model, provider: a.flags.provider as string | undefined, permissions, start: !a.flags["no-start"], runCmd, resumeCmd, session });
}

async function joinCmd(a: ReturnType<typeof parseArgs>) {
  const hubUrl = clean(a._[1] ?? ""), tokenArg = a._[2];
  if (!hubUrl || !tokenArg) die("Usage: fleet join <hub-url> <token|-> --name <name> --harness claude|opencode|prime-agent|codex|antigravity|custom [--dir DIR] [--model M] [--permissions safe|edits|open]");
  const token = tokenArg === "-" ? readFileSync(0, "utf8").trim() : tokenArg;
  const harness = normalizeHarness(a.flags.harness) ?? die(`--harness ${HARNESSES.map((h) => h.id === "prime" ? "prime-agent" : h.id).join("|")} is required.`);
  await joinHere({
    hubUrl, token, name: a.flags.name as string, harness, dir: (a.flags.dir as string) ?? process.cwd(), model: a.flags.model as string | undefined, provider: a.flags.provider as string | undefined,
    permissions: ((a.flags.permissions as string) ?? "safe") as Permissions, start: !a.flags["no-start"],
    runCmd: typeof a.flags["run-cmd"] === "string" ? a.flags["run-cmd"] : undefined, resumeCmd: typeof a.flags["resume-cmd"] === "string" ? a.flags["resume-cmd"] : undefined,
    session: typeof a.flags.session === "string" ? a.flags.session : undefined,
  });
}

async function ls() {
  const agents = listAgents();
  if (!agents.length) return console.log("No agents on this device. Add one: fleet agent add <name> --harness claude --dir <folder>");
  const rows = [["NAME", "HARNESS", "PERMISSIONS", "STATUS", "HUB", "FOLDER"]];
  for (const c of agents) {
    const pid = runningPid(c.name), on = await onlineOnHub(c.name);
    rows.push([c.name, c.harness, c.permissions, pid ? `running (${pid})` : "stopped", on === null ? "-" : on ? "online" : "offline", c.workdir]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
}

async function rm(name: string) {
  const cfg = loadAgent(name);
  await stopAgent(name);
  serviceUninstall(name, true);
  if (loadLogin()) {
    const res = await hubFetch(`/api/agents/${name}`, { method: "DELETE" });
    console.log(res.ok ? `Revoked ${name} on the hub: its token no longer works.` : `The hub says: ${((await res.json().catch(() => ({}))) as any).error ?? res.status}`);
  } else console.log(`Not signed in, so ${name}'s token was not revoked on the hub. Run: fleet login ... and revoke it there.`);
  rmSync(agentFile(name), { force: true });
  console.log(`Removed ${name} from this device (${cfg.workdir} is untouched).`);
}

const plistPath = (name: string) => join(homedir(), "Library", "LaunchAgents", `dev.fleet.agent.${name}.plist`);

function serviceInstall(name: string) {
  if (process.platform !== "darwin") die("Login services are supported on macOS only for now. On Linux, run `fleet start` from a systemd user unit or cron @reboot.");
  loadAgent(name);
  ensureDirs();
  const label = `dev.fleet.agent.${name}`, file = plistPath(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, launchdPlist({ label, bun: process.execPath, script: selfPath(), name, home: home(), log: logFile(name) }));
  if (spawnSync("plutil", ["-lint", file]).status !== 0) die(`Wrote an invalid ${file}.`);
  const uid = String(process.getuid?.() ?? 501);
  spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`]);
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, file]);
  if (r.status !== 0) die(`launchctl could not load the service: ${r.stderr?.toString().trim()}`);
  console.log(`${name} will now start at login and restart if it stops. Remove with: fleet service uninstall ${name}`);
}

function serviceUninstall(name: string, quiet = false, label = `dev.fleet.agent.${name}`, file = plistPath(name)) {
  if (!existsSync(file)) { if (!quiet) console.log(`${name} is not installed as a login service.`); return; }
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${label}`]);
  rmSync(file, { force: true });
  console.log(`Removed the login service for ${name}.`);
}

async function doctor() {
  let bad = 0;
  const line = (ok: boolean | null, text: string) => { if (ok === false) bad++; console.log(`${ok === null ? "-" : ok ? "✓" : "✗"} ${text}`); };
  line(true, `bun ${process.versions.bun ?? "?"}`);
  const found = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { env: { ...process.env, PATH: pathWithTools() } }).stdout.toString().trim();
  const have = new Map(detectHarnesses((bin) => found(bin) || null).map((d) => [d.id, d.path]));
  for (const h of HARNESSES.filter((x) => x.bin)) {
    const p = have.get(h.id);
    line(p ? true : null, p ? `${h.bin} at ${p}` : `${h.bin} not found (only needed for ${h.label} agents)`);
  }
  const login = loadLogin();
  if (login) {
    try {
      const r = await fetch(`${login.hubUrl}/skills.md`);
      line(r.ok, `hub ${login.hubUrl} ${r.ok ? "reachable" : `answered ${r.status}`}`);
      line((await hubFetch("/api/state")).ok, "human token accepted");
    } catch (e) { line(false, `hub ${login.hubUrl} not reachable: ${(e as Error).message}`); }
  } else line(null, "not signed in (fleet login <hub-url> <human-token>) — only needed to add or remove agents");
  for (const c of listAgents()) {
    const problems: string[] = [];
    if (!existsSync(c.workdir)) problems.push(`folder ${c.workdir} is missing`);
    if (!(await checkToken(c.hubUrl, c.token))) problems.push("hub rejected its token (revoked, or wrong hub?)");
    if (harnessInfo(c.harness).bin && !have.get(c.harness)) problems.push(`${harnessInfo(c.harness).bin} is not installed`);
    if (!runningPid(c.name)) problems.push("not running");
    line(problems.length ? false : true, `agent ${c.name}: ${problems.length ? problems.join("; ") : `ok, ${c.permissions}`}`);
  }
  if (bad) process.exit(1);
}

const USAGE = `fleet: manage fleet agents on this device

  fleet hub init [--owner N --host IP --port P --dir D]   set up and start the hub on this machine (start here)
  fleet hub status | start | stop | restart | logs [-f] | token | set | service install|uninstall
  fleet device enroll <hub-url> <token>    let the hub start agents on this machine (add the device in the web UI first)
  fleet device allow|deny <folder> | roots | confirm [id] | status | start | stop | logs

  fleet login <hub-url> <human-token>
  fleet agent add <name> --harness claude|opencode|prime-agent|codex|antigravity|custom [--dir DIR] [--model M] [--permissions safe|edits|open]
                         [--ssh HOST] [--owner NAME] [--print-join] [--print-prompt] [--no-start]
                         [--run-cmd T --resume-cmd T]   (custom: the command templates)
  fleet agent reconnect <name> --harness H [--dir D] ...   new token for an agent that already exists (its token was lost)
  fleet sessions [--dir D]                 list conversations you can import with --session <id> on agent add / reconnect / join
  fleet agent move <name> <workspace>      move an idle agent to another workspace
  fleet workspace ls | add <name>          workspaces group projects, agents, tasks and a room
  fleet agent rm <name>
  fleet install [--hub URL --token T --name N]   print setup instructions for an agent to follow itself
  fleet join <hub-url> <token|-> --name N --harness H [--dir D] [--model M] [--permissions P]
  fleet ls | start <name> | stop <name> | restart <name> | logs <name> [-f] | update | doctor
  fleet service install|uninstall <name>     start at login (macOS)`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const [cmd, sub] = a._;
  switch (cmd) {
    case "hub": return hubCmd(a);
    case "device": return deviceCmd(a);
    case "login": {
      const hubUrl = clean(a._[1] ?? ""), humanToken = a._[2];
      if (!hubUrl || !humanToken) die("Usage: fleet login <hub-url> <human-token>");
      let res: Response;
      try { res = await fetch(`${hubUrl}/api/state`, { headers: { Authorization: `Bearer ${humanToken}` } }); } catch (e) { die(`Could not reach ${hubUrl}: ${(e as Error).message}`); }
      if (!res.ok) die(res.status === 401 ? "The hub did not accept that human token." : `The hub answered ${res.status}.`);
      ensureDirs();
      writePrivate(join(home(), "login.json"), JSON.stringify({ hubUrl, humanToken }));
      return console.log(`Signed in to ${hubUrl}.`);
    }
    case "agent":
      if (sub === "add") return agentAdd(a);
      if (sub === "reconnect") return agentAdd(a, true);
      if (sub === "move" && a._[2] && a._[3]) {
        const r = await hubFetch(`/api/agents/${encodeURIComponent(a._[2])}/workspace`, { method: "POST", body: JSON.stringify({ workspace: a._[3] }) });
        const b: any = await r.json().catch(() => ({}));
        if (!r.ok) die(`The hub refused: ${b.error ?? r.status}`);
        return console.log(`${a._[2]} now works in workspace ${a._[3]}.`);
      }
      if (sub === "rm" && a._[2]) return rm(a._[2]);
      return die("Usage: fleet agent add|rm <name> ...");
    case "workspace": {
      if (sub === "add" && a._[2]) {
        const r = await hubFetch("/api/workspaces", { method: "POST", body: JSON.stringify({ name: a._.slice(2).join(" ") }) });
        const b: any = await r.json().catch(() => ({}));
        if (!r.ok) die(`The hub refused: ${b.error ?? r.status}`);
        return console.log(`Created workspace ${b.name}. Put an agent in it with: fleet agent add <name> --workspace "${b.name}" ...`);
      }
      if (sub === "ls" || !sub) {
        const s: any = await (await hubFetch("/api/state")).json();
        for (const w of s.workspaces) {
          const agents = s.agents.filter((x: any) => x.workspaceId === w.id).map((x: any) => x.name);
          const projects = s.projects.filter((p: any) => p.workspaceId === w.id).map((p: any) => p.name);
          console.log(`${w.name}\n  agents:   ${agents.join(", ") || "-"}\n  projects: ${projects.join(", ") || "-"}`);
        }
        return;
      }
      return die("Usage: fleet workspace ls | add <name>");
    }
    case "integrate": {
      const project=a._[1],branch=a._[2];if(!project||!branch)die("Usage: fleet integrate <project> <agent/branch>");
      const l=needLogin();const headers={Authorization:`Bearer ${l.humanToken}`,"content-type":"application/json"};
      const listing=await fetch(`${l.hubUrl}/api/repos`,{headers});if(!listing.ok)die("Cannot read hub repositories");
      const repo=((await listing.json()) as any[]).find(r=>r.project===project);if(!repo?.main)die("Project has no canonical main; seed it first");
      const response=await fetch(`${l.hubUrl}/api/repos/${encodeURIComponent(project)}/integrate`,{method:"POST",headers,body:JSON.stringify({branch,expectedMain:repo.main})});
      const result=await response.json() as any;if(!response.ok)die(result.error??"Integration refused");return console.log(`${project} main advanced to ${result.toSha}`);
    }
    case "sessions": {
      // What can be imported: this folder's Claude sessions, and the conversations earlier fleet helpers kept.
      const dir = resolve((a.flags.dir as string) ?? process.cwd());
      const mine = listClaudeSessions(dir);
      console.log(`Claude sessions in ${dir}${mine.length ? "" : ": none"}`);
      for (const s of mine) console.log(`  ${s.id}  ${new Date(s.modified).toISOString().slice(0, 16).replace("T", " ")}  ${s.preview || "(no text)"}`);
      const cx = listCodexSessions(dir);
      if (cx.length) {
        console.log(`\nCodex sessions started in ${dir}`);
        for (const s of cx) console.log(`  ${s.id}  ${new Date(s.modified).toISOString().slice(0, 16).replace("T", " ")}  ${s.preview || "(no text)"}`);
      }
      const old = join(homedir(), ".fleet-helper");
      const kept = existsSync(old) ? readdirSync(old).filter((f) => /^(claude|opencode)-[0-9a-f]+\.json$/.test(f)).map((f) => ({ harness: f.split("-")[0], ...JSON.parse(readFileSync(join(old, f), "utf8")) })).filter((x) => x.sessionId) : [];
      if (kept.length) {
        console.log("\nConversations kept by an earlier helper on this device (adopt with --session):");
        for (const k of kept) console.log(`  ${k.harness.padEnd(8)} ${k.sessionId}`);
      }
      return console.log(`\nAdopt one: fleet agent add <name> --harness claude --dir ${dir} --session <id>   (or: fleet agent reconnect <name> ... --session <id>)`);
    }
    case "join": return joinCmd(a);
    case "install": return console.log(installInstructions({ hubUrl: typeof a.flags.hub === "string" ? clean(a.flags.hub) : loadLogin()?.hubUrl, token: a.flags.token as string | undefined, name: a.flags.name as string | undefined }));
    case "ls": return ls();
    case "start": {
      loadAgent(a._[1] ?? die("Usage: fleet start <name>"));
      const pid = startAgent(a._[1]);
      return console.log(`${a._[1]} is running (${pid}).`);
    }
    case "stop": return console.log((await stopAgent(a._[1] ?? die("Usage: fleet stop <name>"))) ? `Stopped ${a._[1]}.` : `${a._[1]} was not running.`);
    case "restart": await stopAgent(a._[1] ?? die("Usage: fleet restart <name>")); loadAgent(a._[1]); return console.log(`${a._[1]} is running (${startAgent(a._[1])}).`);
    case "run": return runAgent(a._[1] ?? die("Usage: fleet run <name>"));
    case "logs": {
      const f = logFile(a._[1] ?? die("Usage: fleet logs <name> [-f]"));
      if (!existsSync(f)) return console.log("No log yet.");
      return void spawnSync("tail", a.flags.f || a.flags.follow ? ["-n", "40", "-f", f] : ["-n", "40", f], { stdio: "inherit" });
    }
    case "update": {
      const l = needLogin();
      await downloadHelper(l.hubUrl);
      if (selfPath() === join(home(), "fleet.ts")) {            // an installed copy updates itself; a copy run from a checkout never overwrites its source
        const res = await fetch(`${l.hubUrl}/fleet.ts`);
        if (res.ok) { writeFileSync(`${selfPath()}.new`, await res.text()); renameSync(`${selfPath()}.new`, selfPath()); console.log("Updated the fleet command."); }
      }
      for (const c of listAgents()) if (runningPid(c.name)) { await stopAgent(c.name); startAgent(c.name); console.log(`Restarted ${c.name} with the latest helper.`); }
      // The device daemon also carries the model discovery, so an update must restart it or the old lists stay on the hub until it restarts by itself.
      if (runningPid(DEVICE)) { await stopAgent(DEVICE); startAgent(DEVICE); console.log("Restarted the device daemon with the latest model discovery."); }
      return console.log("Helper updated.");
    }
    case "service":
      if (sub === "install" && a._[2]) return serviceInstall(a._[2]);
      if (sub === "uninstall" && a._[2]) return serviceUninstall(a._[2]);
      return die("Usage: fleet service install|uninstall <name>");
    case "doctor": return doctor();
    default: console.log(USAGE);
  }
}

if (import.meta.main) await main();
