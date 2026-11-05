import { test, expect, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import { createApp } from "../src/app";

const auth = { authorization: "Bearer human-secret", "content-type": "application/json" };
const peer = { remoteAddress: "127.0.0.1" };
const closeStream = async (response: Response) => { await response.body?.cancel(); };

test("human, agent and device authentication use timingSafeEqual for valid and invalid tokens", async () => {
  const { app, store } = createApp(":memory:", "human-secret");
  const a = store.addAgent({ name: "test", owner: "owner", device: "test", skills: [] });
  const d = store.addDevice("test");
  const compare = spyOn(crypto, "timingSafeEqual");
  try {
    for (const [path, method, token] of [["/api/state", "GET", "human-secret"], ["/agent/pull", "POST", a.token], ["/device/report", "POST", d.token]]) {
      for (const given of [token, "incorrect"]) {
        compare.mockClear();
        const res = await app.request(path, { method, headers: { ...auth, authorization: `Bearer ${given}` }, ...(method === "POST" ? { body: "{}" } : {}) }, peer);
        expect(res.status).toBe(given === token ? 200 : 401);
        expect(compare).toHaveBeenCalled();
        for (const args of compare.mock.calls) { expect(args[0].byteLength).toBe(32); expect(args[1].byteLength).toBe(32); }
      }
    }
  } finally { compare.mockRestore(); store.db.close(); }
});

test("failure budget is shared across authenticated route families per peer IP and recovers after one minute", async () => {
  let now = 1000;
  const { app, store } = createApp(":memory:", "human-secret", { security: { now: () => now } });
  try {
    const paths = ["/api/state", "/mcp", "/device/report", "/agent/pull", "/agent/artifacts", "/git/demo.git/info/refs"];
    for (let i = 0; i < 10; i++) {
      const path = paths[i % paths.length];
      const res = await app.request(path, { method: path === "/api/state" || path.includes("/git/") ? "GET" : "POST", headers: { authorization: "Bearer wrong" } }, peer);
      expect(res.status).toBe(401);
    }
    const limited = await app.request("/api/state", { headers: { authorization: "Bearer wrong" } }, peer);
    expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("60");
    expect((await app.request("/api/state", { headers: auth }, { remoteAddress: "127.0.0.2" })).status).toBe(200);
    now += 60_000;
    expect((await app.request("/api/state", { headers: auth }, peer)).status).toBe(200);
  } finally { store.db.close(); }
});

test("CF client IP is trusted only when explicitly enabled; spoofed forwarding headers cannot evade the default budget", async () => {
  for (const trustProxy of [false, true]) {
    const { app, store } = createApp(":memory:", "human-secret", { security: { trustProxy } });
    try {
      for (let i = 0; i < 10; i++) expect((await app.request("/api/state", { headers: { "CF-Connecting-IP": "192.0.2.1" } }, peer)).status).toBe(401);
      const changed = await app.request("/api/state", { headers: { "CF-Connecting-IP": "192.0.2.2" } }, peer);
      expect(changed.status).toBe(trustProxy ? 401 : 429);
      if (trustProxy) expect((await app.request("/api/state", { headers: { "CF-Connecting-IP": "192.0.2.1" } }, peer)).status).toBe(429);
    } finally { store.db.close(); }
  }
});

test("query tokens are rejected by default and supported only by the explicit compatibility option", async () => {
  for (const allowQueryToken of [false, true]) {
    const { app, store } = createApp(":memory:", "human-secret", { security: { allowQueryToken } });
    try {
      expect((await app.request("/api/state?token=human-secret")).status).toBe(allowQueryToken ? 200 : 401);
      const response = await app.request("/api/events?token=human-secret");
      expect(response.status).toBe(allowQueryToken ? 200 : 401); await closeStream(response);
    } finally { store.db.close(); }
  }
});

test("stream tickets require human authentication, expire in 60 seconds, are single-use and never authorize other routes", async () => {
  let now = 1000;
  const { app, store } = createApp(":memory:", "human-secret", { security: { now: () => now } });
  const mint = async () => {
    const response = await app.request("/api/events/ticket", { method: "POST", headers: auth });
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toContain("no-store");
    return (await response.json()).ticket as string;
  };
  try {
    expect((await app.request("/api/events/ticket", { method: "POST" })).status).toBe(401);
    const ticket = await mint(); expect(ticket).not.toContain("human-secret");
    expect((await app.request(`/api/state?ticket=${ticket}`)).status).toBe(401);
    const stream = await app.request(`/api/events?ticket=${ticket}`);
    expect(stream.status).toBe(200); await closeStream(stream);
    expect((await app.request(`/api/events?ticket=${ticket}`)).status).toBe(401);
    const expired = await mint(); now += 60_000;
    expect((await app.request(`/api/events?ticket=${expired}`)).status).toBe(401);
    expect((await app.request("/api/events?ticket=made-up")).status).toBe(401);
  } finally { store.db.close(); }
});

test("security headers and nonced UI scripts fit the app; HSTS requires proxy trust and forwarded HTTPS", async () => {
  for (const trustProxy of [false, true]) {
    const { app, store } = createApp(":memory:", "human-secret", { security: { trustProxy } });
    try {
      for (const proto of ["http", "https"]) {
        for (const path of ["/", "/api/state"]) {
          const response = await app.request(path, { headers: { ...auth, "X-Forwarded-Proto": proto } }, peer);
          expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
          expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
          expect(response.headers.has("Strict-Transport-Security")).toBe(trustProxy && proto === "https");
          const csp = response.headers.get("Content-Security-Policy") ?? "";
          expect(csp).toContain("frame-ancestors 'none'"); expect(csp).toContain("object-src 'none'");
          if (path === "/") {
            const html = await response.text();
            const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
            expect(nonce).toBeTruthy(); expect(csp).toContain(`'nonce-${nonce}'`);
            expect(csp.split("script-src")[1]?.split(";")[0]).not.toContain("unsafe-inline");
          }
        }
      }
    } finally { store.db.close(); }
  }
});

test("normal Git Basic-auth challenges do not spend the failure budget, but rejected credentials do", async () => {
  const { app, store } = createApp(":memory:", "human-secret");
  try {
    for (let i = 0; i < 12; i++) {
      const challenge = await app.request("/git/demo.git/info/refs", {}, peer);
      expect(challenge.status).toBe(401); expect(challenge.headers.get("WWW-Authenticate")).toContain("Basic");
    }
    expect((await app.request("/api/state", { headers: auth }, peer)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await app.request("/git/demo.git/info/refs", { headers: { authorization: "Basic " + btoa("agent:wrong") } }, peer)).status).toBe(401);
    expect((await app.request("/api/state", { headers: { authorization: "Bearer wrong" } }, peer)).status).toBe(429);
  } finally { store.db.close(); }
});

test("an over-budget shared IP still serves valid human, agent, device and stream credentials without extending the failure window", async () => {
  let now = 1000;
  const { app, store } = createApp(":memory:", "human-secret", { security: { now: () => now } });
  const agent = store.addAgent({ name: "healthy", owner: "owner", device: "test", skills: [] });
  const device = store.addDevice("healthy");
  const bad = () => app.request("/api/state", { headers: { authorization: "Bearer revoked" } }, peer);
  try {
    for (let i = 0; i < 10; i++) expect((await bad()).status).toBe(401);
    expect((await app.request("/api/state", { headers: auth }, peer)).status).toBe(200);
    for (const [path, token] of [["/agent/pull", agent.token], ["/device/report", device.token]]) {
      expect((await app.request(path, { method: "POST", headers: { ...auth, authorization: `Bearer ${token}` }, body: "{}" }, peer)).status).toBe(200);
    }
    const ticketResponse = await app.request("/api/events/ticket", { method: "POST", headers: auth }, peer);
    expect(ticketResponse.status).toBe(200);
    const { ticket } = await ticketResponse.json();
    const stream = await app.request(`/api/events?ticket=${ticket}`, {}, peer);
    expect(stream.status).toBe(200); await closeStream(stream);
    const limited = await bad();
    expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("60");
    now += 30_000;
    const later = await bad();
    expect(later.status).toBe(429); expect(later.headers.get("Retry-After")).toBe("30");
    now += 30_000;
    expect((await bad()).status).toBe(401);
    expect((await app.request("/api/state", { headers: auth }, peer)).status).toBe(200);
  } finally { store.db.close(); }
});
