import { dirname, join } from "node:path";
import { createApp } from "./app";
import { resolveHumanToken } from "./human-token";

const port = Number(process.env.HUB_PORT ?? 8787);
// Loopback by default. Set HUB_HOST to the tailnet address (e.g. 100.x.y.z) to serve the fleet.
const host = process.env.HUB_HOST ?? "127.0.0.1";
const dbPath = process.env.HUB_DB ?? "./fleet.db";
const tokenFile = join(dirname(dbPath), "human-token");
const { token: humanToken, generated } = resolveHumanToken(process.env.HUB_HUMAN_TOKEN, tokenFile);
if (generated) console.log(`No HUB_HUMAN_TOKEN was set, so one was generated and saved to ${tokenFile}.\nHuman token (for the web UI and \`fleet login\`): ${humanToken}`);
const hubOwner = process.env.HUB_OWNER ?? "";
if (!hubOwner) console.warn("HUB_OWNER is not set: every agent is treated as internal. Set it before connecting anyone else's agent.");
function buildApp() {
  try {
    return createApp(dbPath, humanToken, {
      humanAttachmentMaxBytes: process.env.HUB_ATTACHMENT_MAX_BYTES === undefined ? undefined : Number(process.env.HUB_ATTACHMENT_MAX_BYTES),
      humanAttachmentMaxCount: process.env.HUB_ATTACHMENT_MAX_COUNT === undefined ? undefined : Number(process.env.HUB_ATTACHMENT_MAX_COUNT),
      hubOwner, publicUrl: process.env.HUB_PUBLIC_URL,
      security: { trustProxy: process.env.HUB_TRUST_PROXY === "1", allowQueryToken: process.env.HUB_ALLOW_QUERY_TOKEN === "1" },
      leaseMinutes: Number(process.env.HUB_LEASE_MINUTES) || undefined, offerMinutes: Number(process.env.HUB_OFFER_MINUTES) || undefined,
    });
  } catch (e) {
    // A malformed HUB_PUBLIC_URL would put a wrong address in every join prompt, so refuse to start and say why.
    console.error(`The hub did not start: ${(e as Error).message}`);
    process.exit(1);
  }
}
const { app } = buildApp();

// idleTimeout must exceed the longest wait_for_work (25s), or Bun cuts the call off.
Bun.serve({ port, hostname: host, fetch: (request, server) => app.fetch(request, { remoteAddress: server.requestIP(request)?.address }), idleTimeout: 60 });
console.log(`agent-fleet hub on ${host}:${port}, db ${dbPath}`);
