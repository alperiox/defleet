import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Hono } from "hono";
import { tokenDigest } from "./auth";

export interface SecurityOptions { trustProxy?: boolean; allowQueryToken?: boolean; now?: () => number }
const FAILURE_WINDOW_MS = 60_000, FAILURE_LIMIT = 10, TICKET_TTL_MS = 60_000;
const authenticatedPath = /^\/(?:api|mcp|device|agent|artifacts|git)(?:\/|$)/;

export function uiCsp(nonce?: string): string {
  return `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
}

/** A process-local, bounded, single-use capability for just the human SSE endpoint. */
export function streamTickets(now = Date.now) {
  const pending = new Map<string, number>();
  const prune = () => { for (const [key, expires] of pending) if (expires <= now()) pending.delete(key); };
  return {
    mint() {
      prune();
      if (pending.size >= 1000) pending.delete(pending.keys().next().value!);
      const ticket = randomBytes(32).toString("base64url");
      pending.set(tokenDigest(ticket), now() + TICKET_TTL_MS);
      return ticket;
    },
    consume(ticket: string) {
      prune();
      const key = tokenDigest(ticket), expires = pending.get(key);
      pending.delete(key);
      return expires !== undefined && expires > now();
    },
  };
}

/** Install before routes so failures from every authentication family share one IP budget. */
export function mountSecurity(app: Hono, options: SecurityOptions = {}) {
  const now = options.now ?? Date.now;
  const failures = new Map<string, { count: number; until: number }>();
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", uiCsp());
    if (options.trustProxy && c.req.header("x-forwarded-proto") === "https") c.header("Strict-Transport-Security", "max-age=31536000");
    if (!authenticatedPath.test(c.req.path)) return next();
    // server.ts supplies the socket address; forwarding headers are inert unless explicitly trusted.
    const forwarded = c.req.header("cf-connecting-ip");
    const socket = (c.env as { remoteAddress?: string } | undefined)?.remoteAddress;
    const ip = options.trustProxy && forwarded && isIP(forwarded) ? forwarded : typeof socket === "string" ? socket : "unknown";
    const stamp = now();
    for (const [key, entry] of failures) if (entry.until <= stamp) failures.delete(key);
    await next();
    // Git starts each Basic-auth negotiation with an unauthenticated challenge.
    const gitChallenge = c.req.path.startsWith("/git/") && !c.req.header("authorization");
    if (c.res.status === 401 && !gitChallenge) {
      // Re-read after await: concurrent failures must count together, not overwrite each other.
      const current = failures.get(ip);
      if (current && current.until > now() && current.count >= FAILURE_LIMIT) {
        // A stale helper must not lock out healthy clients sharing its IP.
        // Over-budget failures neither add to the counter nor extend its window.
        c.header("Retry-After", String(Math.max(1, Math.ceil((current.until - now()) / 1000))));
        c.res = c.json({ error: "too many authentication failures; try again later" }, 429);
        return;
      }
      if (current && current.until > now()) current.count++;
      else failures.set(ip, { count: 1, until: now() + FAILURE_WINDOW_MS });
    }
  });
}
