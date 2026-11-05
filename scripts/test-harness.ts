// scripts/test-harness.ts — the trivial custom harness used by scripts/test-install.sh.
// The helper runs it for each turn with FLEET_URL and FLEET_TOKEN in the environment. For the install self-check it just
// prints a reply; for a real turn (a wake) it calls the fleet's `say` tool over MCP, which is the documented agent path.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const prompt = process.argv.slice(2).join(" ");
const realTurn = /You are the fleet agent|New items from the fleet hub|Now handle these items/.test(prompt);
if (!realTurn) { console.log("ok"); process.exit(0); }

const url = process.env.FLEET_URL, token = process.env.FLEET_TOKEN;
if (!url || !token) { console.error("FLEET_URL and FLEET_TOKEN are required"); process.exit(1); }
const client = new Client({ name: "test-harness", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url.replace(/\/$/, "") + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  await client.callTool({ name: "say", arguments: { thread: "dm:human", text: "pong from the install test" } });
  console.log("replied");
} finally {
  await client.close().catch(() => {});
}
