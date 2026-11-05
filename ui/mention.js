// @-mention helpers for the message box. Pure functions, so they can be tested without a browser.

/** The mention being typed at the caret, or null. An @ counts only at the start or after whitespace, and only while the caret is right behind it. */
export function mentionAt(text, caret) {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([a-z0-9-]*)$/i.exec(before);
  return m ? { start: m.index + m[1].length, query: m[2] } : null;
}

/** Agents matching the query: prefix matches first, then matches anywhere; online ahead of offline within each group. */
export function suggestAgents(agents, query) {
  const q = query.toLowerCase();
  const rank = (a) => (a.name.toLowerCase().startsWith(q) ? 0 : a.name.toLowerCase().includes(q) ? 1 : 2);
  return agents
    .filter((a) => rank(a) < 2)
    .sort((a, b) => rank(a) - rank(b) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** Replaces the typed fragment with the whole name and a space. Returns the new text and where the caret goes. */
export function applyMention(text, mention, name) {
  const end = mention.start + 1 + mention.query.length;
  const inserted = `@${name} `;
  return { text: text.slice(0, mention.start) + inserted + text.slice(end), caret: mention.start + inserted.length };
}
