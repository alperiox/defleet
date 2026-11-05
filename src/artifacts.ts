import { diskPolicy, diskState, type DiskState } from "./disk";
import { tokenMatches } from "./auth";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import type { Context, Hono } from "hono";
import { HUMAN } from "./hub";
import type { Hub } from "./hub";
import type { Artifact, ArtifactKind, Store } from "./store";

const KINDS: ArtifactKind[] = ["report", "screenshot", "video", "file"];
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
  json: "application/json", html: "text/plain; charset=utf-8", pdf: "application/pdf", log: "text/plain; charset=utf-8",
};
const MAX_UNATTACHED = 50;
const SIGNED_FOR_MS = 6 * 60 * 60 * 1000;

/** Keeps only a plain file name: no folders, no leading dots, a safe character set. */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 100).trim();
  return clean || "file";
}
const mimeFor = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export function mountArtifacts(app: Hono, hub: Hub, store: Store, humanToken: string, dataDir: string, maxBytes: number, storage:()=>DiskState=()=>diskState(dataDir,store.dbPath)): { signedUrl(id: string): string } {
  const dir = `${dataDir}/artifacts`;
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha256").update(humanToken + ":artifacts").digest();
  const sign = (id: string, exp: number) => createHmac("sha256", key).update(`${id}.${exp}`).digest("hex");
  const signedUrl = (id: string) => {
    const a = store.getArtifact(id)!;
    const exp = Date.now() + SIGNED_FOR_MS;
    return `/artifacts/${id}/${encodeURIComponent(a.name)}?exp=${exp}&sig=${sign(id, exp)}`;
  };
  const validSig = (id: string, exp: string | undefined, sig: string | undefined) => {
    const e = Number(exp);
    if (!sig || !Number.isFinite(e) || e <= Date.now() || !/^[a-f0-9]{64}$/.test(sig)) return false;
    return timingSafeEqual(Buffer.from(sign(id, e)), Buffer.from(sig));
  };

  // Reserve bytes not yet visible on disk, so concurrent writers cannot oversubscribe the budget.
  const pending=new Map<string,number>();
  const storageError=(adding=0)=>{const state=storage();let unwritten=0;for(const[path,reserved]of pending){let written=0;try{written=statSync(path).size;}catch{}unwritten+=Math.max(0,reserved-written);}return diskPolicy("upload",{...state,artifacts:state.artifacts+unwritten,free:state.free-unwritten},adding);};

  hub.checkArtifactSpace=(size)=>size>maxBytes?"file too large":storageError(size);

  // Mounted before the owner API middleware: authenticate explicitly, never with an agent token.
  app.post("/api/artifacts", async (c) => {
    const h = c.req.header("authorization") ?? "";
    if (!tokenMatches(h.startsWith("Bearer ") ? h.slice(7) : "", humanToken)) return c.json({ error: "unauthorized" }, 401);
    if (store.unattachedBy(HUMAN) >= MAX_UNATTACHED) return c.json({ error: "too many unattached uploads; send or remove pending files first" }, 429);
    const limit = hub.humanAttachmentMaxBytes;
    if (Number(c.req.header("content-length") ?? 0) > limit) return c.json({ error: `file exceeds the ${limit}-byte attachment limit` }, 413);
    const guard=storageError(Number(c.req.header("content-length")??0));if(guard){hub.diskNotice(guard);return c.json({error:guard},507);}
    const id = crypto.randomUUID(), path = `${dir}/${id}`;
    pending.set(path,0);
    const writer = Bun.file(path).writer();
    const reader = c.req.raw.body?.getReader();
    let size = 0;
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); await writer.end(); rmSync(path, { force: true }); pending.delete(path); return c.json({ error: `file exceeds the ${limit}-byte attachment limit` }, 413); }
        const guard=storageError(value.length);if(guard){await reader.cancel();await writer.end();rmSync(path,{force:true});pending.delete(path);hub.diskNotice(guard);return c.json({error:guard},507);}
        pending.set(path,size);
        writer.write(value);
      }
      await writer.end();
      if (!size) { rmSync(path, { force: true }); pending.delete(path); return c.json({ error: "empty upload" }, 400); }
      // MIME is a display hint only. Human downloads always use an inert binary content type.
      const claimed = (c.req.header("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
      const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(claimed) ? claimed.slice(0, 100) : "application/octet-stream";
      const kind: ArtifactKind = mime.startsWith("image/") ? "screenshot" : mime.startsWith("video/") ? "video" : "file";
      const art = store.addArtifact({ id, name: safeName(c.req.query("name") ?? "file"), kind, mime, size, taskId: null, uploadedBy: HUMAN });
      return c.json({ id: art.id, name: art.name, kind, mime, size });
    } catch {
      try { await writer.end(); } catch {}
      rmSync(path, { force: true });
      return c.json({ error: "upload failed" }, 400);
    } finally { pending.delete(path);reader?.releaseLock(); }
  });

  app.delete("/api/artifacts/:id", (c) => {
    const h = c.req.header("authorization") ?? "";
    if (!tokenMatches(h.startsWith("Bearer ") ? h.slice(7) : "", humanToken)) return c.json({ error: "unauthorized" }, 401);
    const art = store.getArtifact(c.req.param("id"));
    if (!art || art.uploadedBy !== HUMAN || art.messageId != null) return c.json({ error: "not found" }, 404);
    store.db.query("DELETE FROM artifacts WHERE id = ?").run(art.id);
    rmSync(`${dir}/${art.id}`, { force: true });
    return c.json({ ok: true });
  });

  app.post("/agent/artifacts", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const agent = store.agentByToken(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (!agent) return c.json({ error: "unauthorized" }, 401);
    const q = c.req.query();
    // With no task the file waits, unattached, for a message to use it (the `attachments` option of say).
    if (q.task) {
      if (!store.resolveTask(q.task)) return c.json({ error: "no such task" }, 404);
      try { hub.taskHeldBy(agent, q.task); } catch (e) { return c.json({ error: (e as Error).message }, 403); }
    } else if (store.unattachedBy(agent.id) >= MAX_UNATTACHED) {
      return c.json({ error: `you have ${MAX_UNATTACHED} uploads that no message uses yet: attach them to a message first` }, 429);
    }
    const kind = (q.kind ?? "file") as ArtifactKind;
    if (!KINDS.includes(kind)) return c.json({ error: `kind must be one of ${KINDS.join(", ")}` }, 400);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > maxBytes) return c.json({ error: "file too large" }, 413);

    const guard=storageError(declared);if(guard){hub.diskNotice(guard);return c.json({error:guard},507);}
    const id = crypto.randomUUID();
    const path = `${dir}/${id}`;
    pending.set(path,0);
    const writer = Bun.file(path).writer();
    let size = 0;
    const reader = c.req.raw.body?.getReader();
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { await writer.end(); rmSync(path, { force: true }); pending.delete(path); return c.json({ error: "file too large" }, 413); }
        const guard=storageError(value.length);if(guard){await reader.cancel();await writer.end();rmSync(path,{force:true});pending.delete(path);hub.diskNotice(guard);return c.json({error:guard},507);}
        pending.set(path,size);
        writer.write(value);
      }
      await writer.end();
      pending.delete(path);
    } catch {
      pending.delete(path);
      rmSync(path, { force: true });
      return c.json({ error: "upload failed" }, 400);
    }
    if (size === 0) { rmSync(path, { force: true }); pending.delete(path); return c.json({ error: "empty upload" }, 400); }
    const name = safeName(q.name ?? "file");
    const file = { id, kind, name, mime: mimeFor(name), size };
    const art = q.task ? hub.recordArtifact(agent, q.task, file) : hub.recordUpload(agent, file);
    return c.json({ id: art.id, name: art.name, kind: art.kind, size: art.size });
  });

  const serve = (c: Context, art: Artifact): Response => {
    const path = `${dir}/${art.id}`;
    let total: number;
    try { total = statSync(path).size; } catch { return c.json({ error: "not found" }, 404); }
    const headers: Record<string, string> = {
      "content-type": art.uploadedBy === HUMAN ? "application/octet-stream" : art.mime, "accept-ranges": "bytes", "x-content-type-options": "nosniff",
      "content-disposition": `${art.uploadedBy === HUMAN ? "attachment" : "inline"}; filename="${art.name.replace(/"/g, "")}"`, "cache-control": "private, max-age=3600",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(total - Number(range[2]), 0);
      let end = range[1] && range[2] ? Number(range[2]) : total - 1;
      end = Math.min(end, total - 1);
      if (start > end || start >= total) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
      return new Response(Bun.file(path).slice(start, end + 1), {
        status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1) },
      });
    }
    return new Response(Bun.file(path), { headers: { ...headers, "content-length": String(total) } });
  };

  // Agents download outcome files for projects they can see.
  app.get("/agent/artifacts/:id", (c) => {
    const header = c.req.header("authorization") ?? "";
    const agent = store.agentByToken(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (!agent) return c.json({ error: "unauthorized" }, 401);
    const art = store.getArtifact(c.req.param("id"));
    const task = art ? store.getTask(art.taskId) : null;
    if (c.req.header("x-fleet-mode") === "quarantine") agent.quarantined = true;
    const ok = art && (art.uploadedBy === HUMAN ? hub.canReadHumanAttachment(agent, art) : task ? hub.canAccessTask(agent, task) : art.uploadedBy === agent.id);
    if (!art || !ok) return c.json({ error: "not found" }, 404);
    return serve(c, art);
  });

  app.get("/artifacts/:id/:name", async (c) => {
    const id = c.req.param("id");
    const header = c.req.header("authorization") ?? "";
    const isHuman = tokenMatches(header.startsWith("Bearer ") ? header.slice(7) : "", humanToken);
    if (!isHuman && !validSig(id, c.req.query("exp"), c.req.query("sig"))) return c.json({ error: "forbidden" }, 403);
    const art = store.getArtifact(id);
    if (!art) return c.json({ error: "not found" }, 404);
    return serve(c, art);
  });

  return { signedUrl };
}
