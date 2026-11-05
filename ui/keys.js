// Keyboard navigation core: one keymap table, the Normal/Insert rule, and the sequence parser.
// Pure functions only, so tests/ can import this file without a browser. The page imports it as /keys.js,
// the same way it imports /markdown.js and /mention.js.

/** Where a key applies. "list" needs a selected row in the current view; "needs" only on a Needs-you card. */
export const SCOPES = ["global", "list", "thread", "needs", "overlay"];

// The single source of truth. Phase 2 (command palette, editable keymap) reads this table and must not fork it:
// the cheat-sheet, the pending-sequence hint and the binding editor all render from here.
// `keys` holds one or more accepted sequences; a two-character sequence is typed as two presses ("g" then "n").
export const DEFAULT_KEYMAP = [
  { id: "list-down", keys: ["j"], label: "Select the next item", action: "list-down", scope: "list" },
  { id: "list-up", keys: ["k"], label: "Select the previous item", action: "list-up", scope: "list" },
  { id: "open", keys: ["Enter"], label: "Open the selected item", action: "open", scope: "list" },
  { id: "stop", keys: ["x"], label: "Stop and ask", action: "stop", scope: "thread" },
  { id: "composer", keys: ["i", "/"], label: "Write a message", action: "composer", scope: "thread" },
  { id: "back", keys: ["Escape"], label: "Back / close", action: "back", scope: "global" },
  { id: "top", keys: ["g g"], label: "First item", action: "top", scope: "list" },
  { id: "bottom", keys: ["G"], label: "Last item", action: "bottom", scope: "list" },
  { id: "ws-prev", keys: ["["], label: "Previous workspace", action: "ws-prev", scope: "global" },
  { id: "ws-next", keys: ["]"], label: "Next workspace", action: "ws-next", scope: "global" },
  { id: "dm-next", keys: ["J"], label: "Next agent conversation", action: "dm-next", scope: "global" },
  { id: "dm-prev", keys: ["K"], label: "Previous agent conversation", action: "dm-prev", scope: "global" },
  { id: "tab:inbox", keys: ["g n"], label: "Go to Needs you", action: "tab:inbox", scope: "global" },
  { id: "tab:room", keys: ["g r"], label: "Go to Room", action: "tab:room", scope: "global" },
  { id: "tab:tasks", keys: ["g t"], label: "Go to Tasks", action: "tab:tasks", scope: "global" },
  { id: "tab:knowledge", keys: ["g k"], label: "Go to Knowledge", action: "tab:knowledge", scope: "global" },
  { id: "tab:team", keys: ["g m"], label: "Go to Team", action: "tab:team", scope: "global" },
  { id: "tab:devices", keys: ["g d"], label: "Go to Devices", action: "tab:devices", scope: "global" },
  { id: "tab:usage", keys: ["g u"], label: "Go to Usage", action: "tab:usage", scope: "global" },
  { id: "tab:access", keys: ["g a"], label: "Go to Access", action: "tab:access", scope: "global" },
  { id: "tab:code", keys: ["g c"], label: "Go to Code", action: "tab:code", scope: "global" },
  { id: "answer", keys: ["a"], label: "Focus the answer box", action: "answer", scope: "needs" },
  { id: "discuss", keys: ["d"], label: "Discuss this request", action: "discuss", scope: "needs" },
  { id: "help", keys: ["?"], label: "Show all keys", action: "help", scope: "global" },
  { id: "palette", keys: [":"], label: "Open the command palette", action: "palette", scope: "global" },
];

/** Every key sequence that starts another one: "g" is a prefix of "gg" and "g n". */
export function prefixes(map) {
  const out = new Set();
  for (const seq of map.keys()) for (let i = 1; i < seq.length; i++) out.add(seq.slice(0, i));
  return out;
}

/** sequence -> entry. Duplicate sequences keep the last one, the same rule `sequenceConflicts` reports. */
export function buildMap(entries = DEFAULT_KEYMAP) {
  const map = new Map();
  for (const entry of entries) for (const seq of entry.keys) map.set(seq, entry);
  return map;
}

/** Rows in the binding editor: one per action, with the effective keys and the default beside them. */
export function toggleBinding(entries, id, seq) {
  return entries.map((entry) => entry.id === id ? { ...entry, keys: [seq] } : entry);
}

/** Which actions share a sequence. Empty means the table is usable. */
export function sequenceConflicts(entries = DEFAULT_KEYMAP) {
  const seen = new Map(), bad = [];
  for (const entry of entries) for (const seq of entry.keys) {
    const owner = seen.get(seq);
    if (owner && owner !== entry.id) bad.push({ sequence: seq, actions: [owner, entry.id] });
    else if (!owner) seen.set(seq, entry.id);
  }
  return bad;
}

/** A sequence is one key ("Enter", "?") or two single keys ("g n"). Anything else is refused. */
export function validSequence(seq) {
  const key = String(seq || "").trim();
  if (!key) return false;
  const parts = key.split(" ");
  return parts.length === 1 ? parts[0].length > 0 : parts.length === 2 && parts[0].length === 1 && parts[1].length === 1;
}

/** Can this action take this key without stealing it from another action? */
export function rebind(entries, id, seq) {
  const key = String(seq || "").trim();
  if (!key) return { ok: false, reason: "empty" };
  if (!validSequence(key)) return { ok: false, reason: "sequence" };
  const clash = entries.find((entry) => entry.id !== id && entry.keys.includes(key));
  if (clash) return { ok: false, reason: "conflict", with: clash.id, label: clash.label };
  return { ok: true, entries: entries.map((entry) => entry.id === id ? { ...entry, keys: [key] } : entry) };
}

/** Switch a browser keydown event to a sequence token, or null when the event is not ours. */
export function keyToken(event) {
  if (!event || event.isComposing || event.keyCode === 229) return null;   // IME composition: never act
  if (event.ctrlKey || event.metaKey || event.altKey) return null;         // leave browser shortcuts alone
  const key = event.key;
  if (!key) return null;
  if (key === " ") return "space";
  if (key.length > 1 && !["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown"].includes(key)) return null;
  if (key === "Tab" || key === "Backspace") return null;                   // browser focus and editing stay theirs
  return key;
}

/** INSERT while a form field is focused: keys type, they do not navigate. */
export function isInsertTarget(node) {
  if (!node) return false;
  const tag = String(node.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || !!node.isContentEditable;
}

/**
 * Feed one token into the parser.
 * `state` is { pending, at } (pending "" when idle). Returns the action to run, or null, plus the next state.
 * A sequence that is a prefix of a longer one waits; after `timeout` ms the wait is dropped and nothing runs.
 */
export function reduceKey(state, token, map, now = Date.now(), timeout = 1000) {
  let pending = state && state.pending ? state.pending : "";
  let at = state && state.at ? state.at : 0;
  if (pending && now - at > timeout) pending = "";
  if (!token) return { action: null, pending, at, entry: null };
  const candidate = pending ? pending + " " + token : token;
  const entry = map.get(candidate);
  let longer = false;
  for (const seq of map.keys()) if (seq.length > candidate.length && seq.startsWith(candidate)) { longer = true; break; }
  if (entry && !longer) return { action: entry.action, entry, pending: "", at: now };
  if (entry && longer) return { action: null, entry: null, pending: candidate, at: now };
  if (longer) return { action: null, entry: null, pending: candidate, at: now };
  // Not a sequence: a pending prefix dies here, and the token on its own may still be a binding.
  const alone = map.get(token);
  if (alone && pending) return { action: alone.action, entry: alone, pending: "", at: now };
  return { action: null, entry: null, pending: "", at: now };
}

/** The pending-sequence hint ("g …"), empty when nothing is pending. */
export function hintText(pending) {
  return pending ? pending + " …" : "";
}

/** Clamped list selection. `-1` means nothing is selected yet. */
export function clampIndex(index, length) {
  if (!length) return -1;
  if (index < 0) return -1;
  return Math.min(index, length - 1);
}

/** Move a selection by one, wrapping at both ends only when asked. From no selection, down starts at the top. */
export function stepIndex(index, length, delta, wrap = false) {
  if (!length) return -1;
  if (index < 0) return delta > 0 ? 0 : length - 1;
  let next = index + delta;
  if (wrap) next = (next + length) % length;
  return Math.max(0, Math.min(length - 1, next));
}
