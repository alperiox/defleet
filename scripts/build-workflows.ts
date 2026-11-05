// Builds docs/workflows.html from docs/workflows.template.html.
// Placeholders: __TOUR__ (the video), __FLOW:<name>__ (a diagram drawn here, as inline SVG so it follows the page theme).
// Usage: bun scripts/build-workflows.ts [--out path]   (media path in the page is relative: media/fleet-tour.mp4)

import { createHash } from "node:crypto";

const W = 720, GUTTER = 44, FONT = 16, CHAR = 7.8, LINE = 21;

type Kind = "you" | "hub" | "agent" | "helper" | "out";
type Lane = { id: string; label: string; kind: Kind };
type Msg = { from: string; to: string; text: string; deny?: boolean; note?: string };
type Seq = { lanes: Lane[]; msgs: Msg[] };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function wrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > maxChars) { out.push(line); line = word; }
    else line = line ? line + " " + word : word;
  }
  if (line) out.push(line);
  return out;
}

function laneBox(x: number, y: number, w: number, h: number, kind: Kind): string {
  const base = `class="sv-box k-${kind}"`;
  if (kind === "hub") return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${base}/><rect x="${x + 4}" y="${y + 4}" width="${w - 8}" height="${h - 8}" class="sv-inner"/>`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${base}/>`;
}

function sequence(seq: Seq): string {
  const n = seq.lanes.length;
  const usable = W - GUTTER - 20;
  const gap = usable / n;
  const x = (id: string) => GUTTER + gap * (seq.lanes.findIndex((l) => l.id === id) + 0.5);
  const boxW = Math.min(gap - 14, 130), headH = 38;
  let y = headH + 14;
  const rows: string[] = [];
  const bodyTop = y;
  seq.msgs.forEach((m, i) => {
    const x1 = x(m.from), x2 = x(m.to);
    const span = Math.abs(x2 - x1);
    const maxChars = Math.max(18, Math.floor((Math.max(span, 330) - 24) / CHAR));
    const lines = wrap(m.text, maxChars);
    const h = 14 + lines.length * LINE + 16;
    const mid = (x1 + x2) / 2;
    const lineY = y + h - 10;
    const dir = x2 > x1 ? 1 : -1;
    const textY = y + 10 + FONT;
    rows.push(`<line x1="8" y1="${y}" x2="${W - 8}" y2="${y}" class="sv-sep"/>`);
    rows.push(`<circle cx="22" cy="${y + h / 2}" r="12" class="sv-num"/><text x="22" y="${y + h / 2 + 5}" text-anchor="middle" class="sv-numt">${i + 1}</text>`);
    lines.forEach((ln, j) => rows.push(`<text x="${mid}" y="${textY + j * LINE}" text-anchor="middle" class="sv-label">${esc(ln)}</text>`));
    rows.push(`<line x1="${x1}" y1="${lineY}" x2="${x2 - dir * 9}" y2="${lineY}" class="sv-arrow${m.deny ? " deny" : ""}"/>`);
    rows.push(`<path d="M${x2} ${lineY} l${-dir * 11} -6 v12 z" class="sv-head"/>`);
    if (m.deny) rows.push(`<text x="${mid}" y="${lineY - 4}" text-anchor="middle" class="sv-x"></text>`);
    y += h;
  });
  const height = y + 12;
  const life = seq.lanes
    .map((l) => `<line x1="${x(l.id)}" y1="${headH}" x2="${x(l.id)}" y2="${height - 6}" class="sv-life"/>`)
    .join("");
  const heads = seq.lanes
    .map((l) => laneBox(x(l.id) - boxW / 2, 4, boxW, headH - 4, l.kind) + `<text x="${x(l.id)}" y="${4 + (headH - 4) / 2 + 5}" text-anchor="middle" class="sv-head-t k-${l.kind}">${esc(l.label)}</text>`)
    .join("");
  void bodyTop;
  return `<svg viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(seq.msgs.map((m, i) => `${i + 1}. ${m.text}`).join(" "))}" class="flow">${life}${rows.join("")}${heads}</svg>`;
}

// Hand-drawn diagrams -----------------------------------------------------------------------

const arrow = (x1: number, y1: number, x2: number, y2: number, cls = "") => {
  const a = Math.atan2(y2 - y1, x2 - x1), hx = x2 - 11 * Math.cos(a), hy = y2 - 11 * Math.sin(a);
  const px = -Math.sin(a) * 6, py = Math.cos(a) * 6;
  return `<line x1="${x1}" y1="${y1}" x2="${hx}" y2="${hy}" class="sv-arrow ${cls}"/><path d="M${x2} ${y2} L${hx + px} ${hy + py} L${hx - px} ${hy - py} z" class="sv-head"/>`;
};
const box = (x: number, y: number, w: number, h: number, label: string, cls: string, sub?: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="sv-box ${cls}"/>` +
  `<text x="${x + w / 2}" y="${y + h / 2 + (sub ? -2 : 5)}" text-anchor="middle" class="sv-head-t ${cls}">${esc(label)}</text>` +
  (sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 15}" text-anchor="middle" class="sv-small ${cls}">${esc(sub)}</text>` : "");
const text = (x: number, y: number, t: string, cls = "sv-label", anchor = "middle") => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${esc(t)}</text>`;

function overview(): string {
  return `<svg viewBox="0 0 ${W} 300" role="img" aria-label="You talk to the hub. The hub talks to agents through helpers on each device." class="flow">
${box(14, 112, 120, 64, "You", "k-you", "any device")}
${arrow(134, 130, 270, 130)}${arrow(270, 160, 134, 160)}
${text(202, 120, "tasks", "sv-small")}${text(202, 182, "answers", "sv-small")}
<rect x="270" y="40" width="190" height="220" class="sv-box k-hub"/><rect x="274" y="44" width="182" height="212" class="sv-inner"/>
${text(365, 76, "HUB", "sv-head-t k-hub")}
${["tasks and history", "chats and requests", "files and reports", "git remote", "who may do what"].map((t, i) => text(365, 112 + i * 30, t, "sv-label")).join("")}
${box(540, 40, 166, 90, "Agent A", "k-agent", "any MCP agent")}
${box(540, 170, 166, 90, "Agent B", "k-agent", "on another device")}
${box(556, 138, 134, 24, "helper", "k-helper")}
${box(556, 268, 134, 24, "helper", "k-helper")}
${arrow(460, 90, 540, 90)}${arrow(540, 215, 460, 215)}
${text(500, 80, "wake", "sv-small")}${text(500, 208, "status", "sv-small")}
</svg>`;
}

function taskFlow(): string {
  return `<svg viewBox="0 0 ${W} 330" role="img" aria-label="A task starts in backlog or open, moves to claimed, in progress, can be blocked, then the hub checks evidence and open subtasks before it is done." class="flow">
${box(12, 36, 84, 52, "backlog", "k-st-backlog")}
${arrow(96, 62, 134, 62)}
${box(134, 36, 80, 52, "open", "k-st-open")}
${arrow(214, 62, 252, 62)}
${box(252, 36, 104, 52, "claimed", "k-st-claim")}
${arrow(356, 62, 394, 62)}
${box(394, 36, 126, 52, "in progress", "k-st-prog")}
${arrow(520, 62, 564, 62)}
${text(542, 50, "finish", "sv-small")}
<path d="M644 22 L714 62 L644 102 L574 62 z" class="sv-box k-check"/>
${text(644, 58, "hub", "sv-small")}${text(644, 74, "checks", "sv-small")}
${box(394, 160, 126, 52, "blocked", "k-st-block")}
${arrow(442, 88, 442, 160)}${arrow(472, 160, 472, 88)}
${text(418, 130, "stuck", "sv-small", "end")}${text(498, 130, "unblocked", "sv-small", "start")}
${box(580, 160, 126, 52, "done", "k-st-done")}
${arrow(644, 102, 644, 160)}
${text(652, 138, "all pass", "sv-small", "start")}
<path d="M644 22 V8 H457 V36" class="sv-arrow deny" fill="none"/><path d="M457 36 l-6 -10 h12 z" class="sv-head"/>
${text(550, 20, "refused: keep working", "sv-small")}
${text(20, 252, "The hub refuses completion when:", "sv-head-t k-plain", "start")}
${text(20, 276, "✕ Backlog tasks are private until assigned or opened", "sv-label", "start")}
${text(20, 298, "✕ subtasks are still open or evidence is missing", "sv-label", "start")}
${text(380, 276, "✕ a requested outcome report is missing", "sv-label", "start")}
${text(380, 298, "✕ the agent only posted a status update", "sv-label", "start")}
</svg>`;
}

const SEQ: Record<string, Seq> = {
  onboarding: {
    lanes: [
      { id: "you", label: "You", kind: "you" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "dev", label: "Device", kind: "helper" },
      { id: "agent", label: "Agent", kind: "agent" },
    ],
    msgs: [
      { from: "you", to: "hub", text: "First visit opens the welcome tour: hub, workspaces, devices and agents." },
      { from: "you", to: "hub", text: "Step through slides or press Escape; tour closes into the setup checklist." },
      { from: "hub", to: "you", text: "Checklist pinned in Needs you tracks enrollment and setup progress live." },
      { from: "you", to: "dev", text: "Enroll machine, allow project folders, and launch your first agent." },
      { from: "agent", to: "hub", text: "Agent reports online and checklist item marks complete." },
    ],
  },
  join: {
    lanes: [
      { id: "you", label: "You", kind: "you" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "agent", label: "Agent", kind: "agent" },
      { id: "helper", label: "Helper", kind: "helper" },
    ],
    msgs: [
      { from: "you", to: "hub", text: "Add the agent. Token shown once." },
      { from: "you", to: "agent", text: "Give it the hub address and token." },
      { from: "agent", to: "hub", text: "Connects and reads the rulebook." },
      { from: "helper", to: "hub", text: "Opens one quiet connection." },
      { from: "hub", to: "helper", text: "Wake: news for this agent." },
      { from: "helper", to: "agent", text: "Runs one short turn. Idle costs nothing." },
    ],
  },
  talk: {
    lanes: [
      { id: "a", label: "Agent A", kind: "agent" },
      { id: "b", label: "Agent B", kind: "agent" },
      { id: "you", label: "You", kind: "you" },
    ],
    msgs: [
      { from: "a", to: "b", text: "Asks about a task. Its owner is woken." },
      { from: "b", to: "a", text: "Answers in the same thread." },
      { from: "b", to: "you", text: "Needs a decision: a card in Needs you." },
      { from: "you", to: "b", text: "Discuss: opens a private thread linked to the request." },
      { from: "you", to: "b", text: "Align privately, then reply with your decision." },
    ],
  },
  stop: {
    lanes: [
      { id: "you", label: "You", kind: "you" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "helper", label: "Helper", kind: "helper" },
      { id: "agent", label: "Agent", kind: "agent" },
    ],
    msgs: [
      { from: "you", to: "hub", text: "Press Stop on an active agent in header or Team view." },
      { from: "hub", to: "helper", text: "Interrupt signal delivered to running process group." },
      { from: "helper", to: "agent", text: "Turn paused cleanly; task lease and conversation kept intact." },
      { from: "you", to: "hub", text: "Stop and ask: deliver your question or redirection prompt." },
      { from: "hub", to: "agent", text: "Agent resumes turn with your new question in context." },
    ],
  },
  disagree: {
    lanes: [
      { id: "a", label: "Agent A", kind: "agent" },
      { id: "b", label: "Agent B", kind: "agent" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "you", label: "You", kind: "you" },
    ],
    msgs: [
      { from: "a", to: "b", text: "Try to settle it in chat first." },
      { from: "a", to: "hub", text: "Escalate with both positions. Task is blocked." },
      { from: "hub", to: "you", text: "One card shows each side." },
      { from: "you", to: "a", text: "Your decision, as the answer." },
      { from: "you", to: "b", text: "Your decision, as a message." },
    ],
  },
  outcome: {
    lanes: [
      { id: "you", label: "You", kind: "you" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "agent", label: "Agent", kind: "agent" },
    ],
    msgs: [
      { from: "you", to: "hub", text: "Request an outcome report." },
      { from: "hub", to: "agent", text: "Owner told. Task cannot complete without it." },
      { from: "agent", to: "hub", text: "Uploads screenshots and a demo video." },
      { from: "agent", to: "hub", text: "Attaches the written report." },
      { from: "agent", to: "hub", text: "Completes. Now the hub allows it." },
      { from: "hub", to: "you", text: "Read report, shots and video on the task page." },
    ],
  },
  knowledge: {
    lanes: [
      { id: "agent", label: "Agent", kind: "agent" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "you", label: "You", kind: "you" },
    ],
    msgs: [
      { from: "agent", to: "hub", text: "Proposes a note: key, category, sources and verification." },
      { from: "hub", to: "you", text: "Proposal surfaces in Knowledge tab for human review." },
      { from: "you", to: "hub", text: "Review, edit if needed, and approve or archive." },
      { from: "hub", to: "agent", text: "Approved notes become queryable across workspace agents." },
    ],
  },
  code: {
    lanes: [
      { id: "agent", label: "Agent", kind: "agent" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "other", label: "Other agent", kind: "agent" },
      { id: "you", label: "You", kind: "you" },
    ],
    msgs: [
      { from: "agent", to: "hub", text: "Pushes to its own branch: name/topic." },
      { from: "hub", to: "agent", text: "Direct pushes to main are rejected by the hub.", deny: true },
      { from: "other", to: "hub", text: "Fetches branch and builds or tests on it." },
      { from: "you", to: "hub", text: "Code tab: review ahead/behind commits and click Integrate." },
      { from: "hub", to: "hub", text: "Fast-forward merge safely advances canonical main." },
    ],
  },
  devices: {
    lanes: [
      { id: "you", label: "You", kind: "you" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "dev", label: "Device", kind: "helper" },
      { id: "agent", label: "Agent", kind: "agent" },
    ],
    msgs: [
      { from: "you", to: "hub", text: "Add a device. Enroll the machine with one command." },
      { from: "you", to: "dev", text: "Allow the folders agents may run in. Nothing else is." },
      { from: "you", to: "hub", text: "Add agent: tool, folder, model, permissions." },
      { from: "hub", to: "dev", text: "Launch request. The device checks it again itself." },
      { from: "dev", to: "you", text: "Open permission? It waits for your confirm on the device." },
      { from: "dev", to: "agent", text: "Starts it. It reports online and picks up work." },
    ],
  },
  models: {
    lanes: [
      { id: "you", label: "You", kind: "you" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "dev", label: "Device", kind: "helper" },
      { id: "tool", label: "Tool", kind: "agent" },
    ],
    msgs: [
      { from: "you", to: "hub", text: "Add an agent on a device." },
      { from: "hub", to: "dev", text: "Ask what is installed and which models it offers." },
      { from: "dev", to: "tool", text: "Runs the tool's own listing command." },
      { from: "tool", to: "dev", text: "Model values, or an error." },
      { from: "dev", to: "hub", text: "Catalog, cached for ten minutes." },
      { from: "hub", to: "you", text: "Dropdown, Tool default, or the reason it is empty." },
    ],
  },
  delegation: {
    lanes: [
      { id: "a", label: "Agent A", kind: "agent" },
      { id: "b", label: "Agent B", kind: "agent" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "you", label: "You", kind: "you" },
    ],
    msgs: [
      { from: "a", to: "hub", text: "Sets a profile: what it is for. Teammates see it." },
      { from: "a", to: "b", text: "Offers a task. It is not an order." },
      { from: "b", to: "hub", text: "Accepts (lease starts) or declines with a reason." },
      { from: "hub", to: "a", text: "Decline: reason back, task to the pool." },
      { from: "hub", to: "a", text: "No answer in 15 minutes: the offer expires." },
      { from: "you", to: "hub", text: "Assign to… gives it directly, even after a decline." },
      { from: "b", to: "hub", text: "Releases with a brief: done, left, where the files are." },
      { from: "hub", to: "a", text: "Brief as a handoff note and a message." },
    ],
  },
  lease: {
    lanes: [
      { id: "a", label: "Agent A", kind: "agent" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "b", label: "Agent B", kind: "agent" },
      { id: "you", label: "You", kind: "you" },
    ],
    msgs: [
      { from: "a", to: "hub", text: "Claims the task. A lease, with a visible holder." },
      { from: "b", to: "hub", text: "Tries the same task." },
      { from: "hub", to: "b", text: "Refused: held by A. Do not work on it in parallel.", deny: true },
      { from: "b", to: "hub", text: "A silent for 30 minutes? B's claim takes it over." },
      { from: "you", to: "hub", text: "Or reassign it yourself, at any moment." },
    ],
  },
  workspaces: {
    lanes: [
      { id: "you", label: "You", kind: "you" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "han", label: "han-test", kind: "agent" },
      { id: "shop", label: "shop", kind: "agent" },
    ],
    msgs: [
      { from: "you", to: "hub", text: "Make a workspace per piece of work." },
      { from: "hub", to: "han", text: "Its tasks, room and projects reach only its agents." },
      { from: "hub", to: "shop", text: "Same for shop. They never see each other's work." },
      { from: "shop", to: "you", text: "Needs you stays in one place, tagged by workspace." },
    ],
  },
  outside: {
    lanes: [
      { id: "out", label: "Outside agent", kind: "out" },
      { id: "hub", label: "Hub", kind: "hub" },
      { id: "desk", label: "Front desk", kind: "helper" },
      { id: "you", label: "You", kind: "you" },
    ],
    msgs: [
      { from: "you", to: "hub", text: "Grant one project. Nothing else is visible." },
      { from: "out", to: "hub", text: "Asks for work or a finished outcome." },
      { from: "hub", to: "desk", text: "Sandbox session: no files, no shell. Marked untrusted." },
      { from: "desk", to: "you", text: "Needs your files? An approval card shows what leaves." },
      { from: "out", to: "you", text: "Wants a task of yours? Approve or decline.", deny: false },
    ],
  },
};

const FLOWS: Record<string, () => string> = { overview, task: taskFlow, ...Object.fromEntries(Object.entries(SEQ).map(([k, v]) => [k, () => sequence(v)])) };

const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="8" height="8" class="hatch-bg"/><rect width="3" height="8" class="hatch-fg"/></pattern>
</defs></svg>`;

const root = new URL("..", import.meta.url).pathname;
const outIdx = process.argv.indexOf("--out");
const out = outIdx > 0 ? process.argv[outIdx + 1] : `${root}docs/workflows.html`;

let html = await Bun.file(`${root}docs/workflows.template.html`).text();
const musicFile = Bun.file(`${root}docs/media/fleet-tour-music.mp4`), silentFile = Bun.file(`${root}docs/media/fleet-tour-silent.mp4`);
const musicExists = await musicFile.exists(), silentExists = await silentFile.exists();
const main = musicExists ? { name: "fleet-tour-music.mp4", file: musicFile } : silentExists ? { name: "fleet-tour-silent.mp4", file: silentFile } : null;
const videoVersion = main ? createHash("sha256").update(new Uint8Array(await main.file.arrayBuffer())).digest("hex").slice(0, 12) : "preview";
const tour = main
  ? `<video controls loop preload="metadata" playsinline src="media/${main.name}?v=${videoVersion}"><p>Tour video: <code>media/${main.name}</code></p></video>\n  <p class="note">Current UI, recorded with demo data.${musicExists && silentExists ? ' Prefer no sound? <a href="media/fleet-tour-silent.mp4">Watch the silent version</a>.' : ""}${musicExists ? ' Music: see <a href="https://github.com/alperiox/defleet/blob/main/docs/media/CREDITS.md">credits</a>.' : ""}</p>`
  : `<div class="tour-missing"><p>The tour video will appear here once it is rendered with <code>bash scripts/record-demo.sh</code>.</p></div>`;
html = html.replace("__TOUR__", tour);
html = html.replace(/__FLOW:([a-z]+)__/g, (_m, name: string) => {
  const f = FLOWS[name];
  if (!f) throw new Error(`unknown diagram: ${name}`);
  return f();
});
html = html.replace("</style>\n\n<header", `</style>\n${DEFS}\n<header`);
if (/__[A-Z]+__/.test(html) || /__FLOW/.test(html)) throw new Error("unreplaced placeholder");
await Bun.write(out, html);
if (outIdx < 0) await Bun.write(`${root}docs/index.html`, html);   // GitHub Pages serves docs/index.html as the site home
console.log(`wrote ${out} (${html.length} bytes)`);
