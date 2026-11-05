// Minimal, safe markdown for agent messages. It returns a tree of plain objects and never HTML,
// so the UI can build DOM with textContent only. Raw HTML in the source stays literal text.

const SAFE = ["http:", "https:"];
export function safeHref(u) {
  try { const x = new URL(u); return SAFE.includes(x.protocol) ? x.href : null; } catch { return null; }
}

const text = (v) => ({ t: "text", v });

export function parseInline(src) {
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(text(buf)); buf = ""; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) { flush(); out.push({ t: "code", v: src.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) { flush(); out.push({ t: "b", c: parseInline(src.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if (ch === "*" && src[i + 1] !== " " && src[i + 1] !== "*") {
      const end = src.indexOf("*", i + 1);
      if (end > i + 1 && src[end - 1] !== " ") { flush(); out.push({ t: "i", c: parseInline(src.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    if (ch === "[") {
      const close = src.indexOf("](", i + 1);
      const paren = close > i ? src.indexOf(")", close + 2) : -1;
      if (close > i && paren > close) {
        const label = src.slice(i + 1, close), href = safeHref(src.slice(close + 2, paren).trim());
        if (href) { flush(); out.push({ t: "a", href, c: parseInline(label) }); i = paren + 1; continue; }
        flush(); out.push(text(label)); i = paren + 1; continue; // unsafe target: keep the label, drop the link
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes("-");
const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => parseInline(c.trim()));

function paragraph(lines) {
  const inl = [];
  lines.forEach((l, k) => { if (k) inl.push({ t: "br" }); inl.push(...parseInline(l)); });
  return { t: "p", inl };
}

export function parseMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  const endPara = () => { if (para.length) { blocks.push(paragraph(para)); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^```\s*([\w+-]*)\s*$/.exec(line))) {
      endPara();
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ t: "code", lang: m[1], text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { endPara(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { endPara(); blocks.push({ t: "h", level: m[1].length, inl: parseInline(m[2]) }); continue; }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { endPara(); blocks.push({ t: "hr" }); continue; }
    if (/^\s*>/.test(line)) {
      endPara();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--;
      blocks.push({ t: "quote", blocks: parseMarkdown(q.join("\n")) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      endPara();
      const head = cells(line), rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      endPara();
      const kind = ul ? "ul" : "ol", re = ul ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      const items = [];
      while (i < lines.length && (m = re.exec(lines[i]))) { items.push(parseInline(m[1])); i++; }
      i--;
      blocks.push({ t: kind, items });
      continue;
    }
    para.push(line);
  }
  endPara();
  return blocks;
}
