// The ":" command palette and the editable keymap: pure functions, so tests/ can import this file
// without a browser. The page imports it as /palette.js (route in src/api.ts, next to /keys.js).
// The keymap table stays in ui/keys.js: this file only ranks what it lists and rebinds what it owns,
// and it always validates a stored binding through keys.js rebind() before reading it back.

import { DEFAULT_KEYMAP, rebind } from "./keys.js";

// ---- Fuzzy ranking ----
// Scores are on one scale so results from different verbs can share a sorted list:
// exact > prefix > word-start match > plain match > subsequence > no match (null).

export function fuzzyScore(query, text) {
  const q = String(query ?? "").trim().toLowerCase(), t = String(text ?? "").toLowerCase();
  if (!q) return null;
  if (q === t) return 1000;
  if (t.startsWith(q)) return 800 + Math.round((q.length / t.length) * 100);
  const at = t.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s/_-]/.test(t.charAt(at - 1));
    return wordStart ? 600 - Math.min(at, 100) : 400 - Math.min(at, 100);
  }
  // Subsequence: typing "bcx" still finds "abcxe" but scores lower the more it skips.
  let score = 200, prev = -1, gaps = 0;
  for (const ch of q) {
    const hit = t.indexOf(ch, prev + 1);
    if (hit < 0) return null;
    if (hit === prev + 1) score += 12; else { score += 4; gaps += hit - prev - 1; }
    prev = hit;
  }
  const first = t.indexOf(q.charAt(0));
  if (first === 0 || /[\s/_-]/.test(t.charAt(first - 1))) score += 30;
  return Math.max(10, score - gaps);
}

/** Sorted, filtered items. Ties keep the catalogue's order; an empty query keeps the whole list. */
export function rankItems(query, items = []) {
  const q = String(query ?? "").trim();
  if (!q) return items.slice();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let best = 0, any = false;
    const texts = [it.label, ...(it.keywords || [])];
    for (let k = 0; k < texts.length; k++) {
      // Keywords score slightly below the label itself, so a title match outranks a keyword echo of it.
      const s = fuzzyScore(q, texts[k]);
      const weight = k === 0 ? 1 : 0.95;
      if (s != null && s * weight > best) { best = s * weight; any = true; }
    }
    if (any) out.push({ item: it, score: Math.round(best), index: i });
  }
  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return out.map((x) => x.item);
}

// ---- Commands: ":agent codex" narrows, "codex" searches everything ----

export const PALETTE_KINDS = ["agent", "workspace", "task", "tab", "key"];
export const VERB_KIND = { agent: "agent", dm: "agent", ws: "workspace", workspace: "workspace", task: "task", tab: "tab", key: "key" };

/** { kind, arg }. kind null means "rank everything against arg". */
export function parseCommand(query) {
  const raw = String(query ?? "");
  if (!raw.startsWith(":")) return { kind: null, arg: raw.trim() };
  const rest = raw.slice(1).trim();
  if (!rest) return { kind: null, arg: "" };
  const cut = rest.indexOf(" ");
  const verb = (cut < 0 ? rest : rest.slice(0, cut)).toLowerCase();
  const arg = cut < 0 ? "" : rest.slice(cut + 1).trim();
  const kind = VERB_KIND[verb];
  if (verb === "tour") return { kind: "key", arg: arg || "tour" };
  return kind ? { kind, arg } : { kind: null, arg: rest.trim() };
}

// ---- The catalogue ----
// source is only what a view already holds (agents, workspaces, tasks, tabs, the keymap's actions);
// the page builds it fresh on every render, so stale entries cannot show up.

export function paletteItems(source = {}) {
  const out = [];
  for (const a of source.agents || [])
    out.push({ kind: "agent", label: a.name, detail: a.external ? "outside agent · open DM" : "open DM" + (a.status ? " · " + a.status : ""), keywords: ["agent", "dm", a.name], target: "dm:" + a.name });
  for (const w of source.workspaces || [])
    out.push({ kind: "workspace", label: w.name, detail: "switch workspace", keywords: ["ws", "workspace", w.name], target: "ws:" + w.id });
  for (const t of source.tasks || []) {
    if (!(t.key || t.id)) continue;
    out.push({ kind: "task", label: (t.key ? t.key + " " : "") + t.title, detail: "open task" + (t.status ? " · " + t.status : ""), keywords: ["task", t.key || "", t.title], target: "task:" + (t.key || t.id) });
  }
  for (const tab of source.tabs || [])
    out.push({ kind: "tab", label: tab.label, detail: "go to " + tab.label, keywords: ["tab", "go", tab.view], target: "tab:" + tab.view });
  for (const e of source.keymapActions || [])
    out.push({ kind: "key", label: e.label, detail: "run" + (e.keys && e.keys.length ? " · " + e.keys.join(" / ") : ""), keywords: ["key", "run", e.action, e.id], target: "key:" + e.id });
  if (source.tour)
    out.push({ kind: "key", label: "Welcome tour", detail: "take the first-run tour", keywords: ["tour", "welcome", "onboarding", "intro", "help"], target: "tour:open" });
  return out;
}

// ---- The stored, user-editable keymap ----
// One localStorage key maps action id -> the user's key sequence. Everything is validated against the
// default table on load, so a stale or conflicting entry silently falls back instead of breaking the keys.

export const KEYMAP_STORE = "fleet-keymap-v1";

export function readOverrides(storage) {
  try {
    const v = JSON.parse((storage && storage.getItem(KEYMAP_STORE)) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function writeOverrides(storage, overrides) {
  try { (storage || window).setItem(KEYMAP_STORE, JSON.stringify(overrides || {})); } catch {}
}

/** Overrides that differ from the default table: id -> the first accepted sequence of the entry. */
export function overridesFor(entries, defaults) {
  const out = {}, byId = new Map(defaults.map((e) => [e.id, e]));
  for (const e of entries) {
    const def = byId.get(e.id);
    if (!def || JSON.stringify(e.keys) === JSON.stringify(def.keys) || !e.keys.length) continue;
    out[e.id] = e.keys[0];
  }
  return out;
}

/** Save the effective table: only real departures from the defaults are written. */
export function saveKeymap(storage, entries, defaults = DEFAULT_KEYMAP) {
  writeOverrides(storage, overridesFor(entries, defaults));
}

/** Read the stored keymap back, dropping anything the default table would refuse. */
export function loadKeymap(storage, defaults = DEFAULT_KEYMAP) {
  const stored = readOverrides(storage);
  let entries = defaults.slice();
  const kept = {};
  for (const [id, seq] of Object.entries(stored)) {
    if (!defaults.some((e) => e.id === id)) continue;   // an action that no longer exists is not a binding
    const outcome = rebind(entries, id, String(seq));
    if (!outcome.ok) continue;
    entries = outcome.entries;
    const def = defaults.find((e) => e.id === id);
    // A binding that equals its own default is not a customization; do not keep it around.
    if (!(def && def.keys.length === 1 && def.keys[0] === String(seq))) kept[id] = seq;
  }
  return { entries, overrides: kept };
}
