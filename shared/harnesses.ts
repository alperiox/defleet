// The harnesses the fleet knows. One place, so the CLI, the helper and (later) the device agent agree on what exists,
// what each can do, and how to recognise it on a machine. The helper and the CLI are served to other devices as single
// bundled files, so this module is plain data and pure functions.

export type HarnessId = "claude" | "opencode" | "prime" | "codex" | "antigravity" | "custom";

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  /** The command that proves it is installed on a device; null when the harness is a command the user supplies. */
  bin: string | null;
  /** The names people type for it. */
  aliases: string[];
  model: "required" | "optional" | "none";
  modelExample?: string;
  /** The permission levels it can be started with, safest first. */
  permissions: ("safe" | "edits" | "open")[];
  /** Has a mode where the agent gets the fleet tools and nothing else. */
  safeMode: boolean;
  /** Can run outside agents' requests in a sandboxed front-desk session. */
  quarantine: boolean;
  /** Written from the tool's documentation and not yet seen working end to end: the first add runs a self-check. */
  unverified?: boolean;
  /** Checks a session id someone wants to adopt; returns why it cannot, or null. */
  sessionId(id: string): string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const HARNESSES: HarnessInfo[] = [
  { id: "claude", label: "Claude Code", bin: "claude", aliases: ["claude", "claude-code"], model: "optional", permissions: ["safe", "edits", "open"], safeMode: true, quarantine: true,
    sessionId: (id) => (UUID.test(id) ? null : "a Claude session id is a UUID (list them with: fleet sessions --dir <folder>)") },
  { id: "opencode", label: "opencode", bin: "opencode", aliases: ["opencode"], model: "required", modelExample: "opencode-go/deepseek-v4.1-flash", permissions: ["safe", "open"], safeMode: true, quarantine: false,
    sessionId: (id) => (/^ses_[A-Za-z0-9]+$/.test(id) ? null : "an opencode session id starts with ses_ (see `opencode session list`)") },
  { id: "prime", label: "prime-agent", bin: "prime-agent", aliases: ["prime", "prime-agent"], model: "required", modelExample: "gpt-5.6-luna", permissions: ["open"], safeMode: false, quarantine: false,
    sessionId: () => "prime-agent sessions are folders the helper manages, so an existing one cannot be adopted yet" },
  // The example is a slug the installed CLI itself lists (codex debug models), so it can be typed and works; the model
  // may also be left out, and then Codex uses its own default.
  { id: "codex", label: "Codex", bin: "codex", aliases: ["codex"], model: "optional", modelExample: "gpt-6.1-sol", permissions: ["safe", "edits", "open"], safeMode: true, quarantine: false,
    sessionId: (id) => (UUID.test(id) ? null : "a Codex session id is a UUID (list them with: fleet sessions --dir <folder>)") },
  // Antigravity CLI (`agy`) uses a credential-free workspace stdio registration. Each process inherits its own
  // Fleet connection from the environment, so agents sharing a folder keep separate identities.
  { id: "antigravity", label: "Antigravity", bin: "agy", aliases: ["antigravity", "agy"], model: "optional", modelExample: "gemini-3.8-flash-medium", permissions: ["safe", "edits", "open"], safeMode: true, quarantine: false, unverified: true,
    sessionId: (id) => (UUID.test(id) ? null : "an Antigravity conversation id is a UUID (it is printed as conversation_id by: agy -p ... --output-format json)") },
  { id: "custom", label: "Your own tool", bin: null, aliases: ["custom"], model: "optional", permissions: ["open"], safeMode: false, quarantine: false,
    sessionId: (id) => (id.trim() ? null : "the session id is empty") },
];

export const harnessInfo = (id: HarnessId): HarnessInfo => HARNESSES.find((h) => h.id === id)!;

/** Accepts the names people type. Anything not supported is rejected. */
export function normalizeHarnessName(v: unknown): HarnessId | null {
  if (typeof v !== "string") return null;
  const n = v.trim().toLowerCase();
  return HARNESSES.find((h) => h.aliases.includes(n))?.id ?? null;
}

/** What a device has: every harness whose command can be found, in registry order, plus the user-supplied one. */
export function detectHarnesses(which: (bin: string) => string | null): { id: HarnessId; label: string; path: string | null }[] {
  const out: { id: HarnessId; label: string; path: string | null }[] = [];
  for (const h of HARNESSES) {
    if (h.bin === null) { out.push({ id: h.id, label: h.label, path: null }); continue; }
    const path = which(h.bin);
    if (path) out.push({ id: h.id, label: h.label, path });
  }
  return out;
}

export const validateSessionId = (harness: HarnessId, id: string): string | null => harnessInfo(harness).sessionId(id);
