# Configuration

[README](../README.md) · [Operations](operations.md)

## Network and tokens

The simplest setup is one always-on hub on a private tailnet. `hub init` prefers the local tailnet address, falls back to loopback, uses port 8787 and stores data beneath `~/.fleet/hub-data`. Its human token is the password for both the UI and CLI administration. The token file has owner-only permissions. Agents and devices have separate tokens, stored as hashes on the hub; revoke them independently.

A loopback-bound hub cannot be reached directly from another device. For an HTTPS tunnel, keep the origin on loopback, configure the public URL, and enable trusted proxy mode only if clients cannot bypass that proxy. See [public access](public-access.md). The UI's live updates use short-lived, single-use tickets; ordinary API calls use bearer tokens. Keep query-token compatibility off unless migrating an old client.

## Hub environment

When using `fleet hub init`, manage saved settings through `fleet hub set`. When running the server directly, its defaults are:

| Variable | Default and purpose |
| --- | --- |
| `HUB_OWNER` | Empty; set an owner label before inviting outsiders. A different agent owner is classified as external. |
| `HUB_HOST` | `127.0.0.1`; bind to a private tailnet address or to loopback behind a trusted tunnel. |
| `HUB_PORT` | `8787`. |
| `HUB_DB` | `./fleet.db`; `data/repos` and `data/artifacts` live beside the database. |
| `HUB_HUMAN_TOKEN` | Unset generates and saves a human token beside the database on first start. |
| `HUB_PUBLIC_URL` | Unset uses request origin. Otherwise an HTTP(S) origin with no path, credentials or query; used in install and join prompts. |
| `HUB_TRUST_PROXY` | Off; `1` trusts the tunnel's client-IP/HTTPS headers. Bind to loopback to prevent bypass. |
| `HUB_ALLOW_QUERY_TOKEN` | Off; `1` temporarily supports legacy owner query-token clients. |
| `HUB_LEASE_MINUTES` | `30`; silent agents with no running turn can lose an expired task lease. |
| `HUB_OFFER_MINUTES` | `15`; unanswered task offers return to the pool. |
| `HUB_ATTACHMENT_MAX_BYTES` | `26214400` (25 MiB) per human message file; positive integer. |
| `HUB_ATTACHMENT_MAX_COUNT` | `10`; integer from 1 to 10. |

Restart after changing server environment. The browser receives the configured attachment limits. The 200 MiB agent artifact limit and separate disk budgets still apply; see [storage](operations.md#storage-and-maintenance).

## Helper environment

The CLI writes agent configuration with owner-only permissions and supplies this environment when starting the helper. Usually you should use the UI or CLI rather than manage it manually.

| Variable | Purpose |
| --- | --- |
| `FLEET_URL`, `FLEET_TOKEN` | Hub origin and this agent's token; both required. |
| `FLEET_HARNESS` | Required helper harness ID (`prime` internally for prime-agent). |
| `FLEET_WORKDIR` | Agent's folder; defaults to the current directory. |
| `FLEET_MODEL` | Harness model; required for OpenCode and prime-agent. |
| `FLEET_PROVIDER` | prime-agent provider; defaults to `opencode-go`. |
| `FLEET_STATE_DIR` | Helper session/checkpoint directory; manual default `~/.fleet-helper`, CLI-managed under its state folder. |
| `FLEET_SESSION_ID` | Adopt an explicit existing session; never choose another agent's latest conversation. |
| `FLEET_EXTRA_ARGS` | Harness permission arguments, normally produced by the CLI. |
| `FLEET_UNTRUSTED` | `refuse` or verified `quarantine`; only Claude's front desk is verified by default. |
| `FLEET_RUN_CMD`, `FLEET_RESUME_CMD` | Custom first-turn and resume command templates. |
| `FLEET_PROJECT`, `FLEET_BRANCH`, `FLEET_BASE` | Canonical launch identity supplied by project-aware device setup. |
| `FLEET_HOME` | CLI installation/configuration root; default `~/.fleet`. |

## Permissions and harnesses

| Harness | Safe | Edits | Open |
| --- | --- | --- | --- |
| Claude | Fleet tools only | Workspace editing | Unattended commands |
| OpenCode | Fleet tools only | Tool permission policy | Unattended commands |
| Codex | Read-only sandbox and fleet tools | Workspace-write sandbox | Sandbox bypass |
| Antigravity | Deny rules for files, shell and web | File access with tool rules | Unrestricted tool permissions |
| Custom / prime-agent | Unsupported | Unsupported | Required |

Antigravity rules are tool policy, not OS isolation. Outside requests are refused by Codex, Antigravity, custom and prime-agent helpers; OpenCode also refuses by default because its quarantine is not verified. Claude's front desk runs separately in an empty folder without built-in tools or other MCP servers. A fully trusted team token remains powerful even if a client chooses to omit a quarantine header.

The device reads model choices from installed harnesses and shows their source or failure. Use **Tool default** when supported, or **Other…** to enter a model value you have verified with that tool. Do not treat a cached catalog as a promise of account access or available quota.

## Custom connectors

Use **Devices → Connect my own tool** for a token-bearing setup prompt, or create one with the CLI's `--print-prompt` option. A custom connector must register the fleet MCP server using its own agent token, then supply a first-turn command and a command that resumes the same session.

Template placeholders are `{prompt}`, `{session}`, `{workdir}` and `{model}`. Each substitution stays one argument; no shell is implicitly used. If your template needs a shell, make that an explicit executable and understand the escaping. A command that uses `{model}` must receive a model. The self-check sends a word in one turn and asks for it in a second; it must recall the word before the helper is accepted. Without a resume command, each turn runs the first-turn command, so the tool itself must preserve session state.

Custom connectors require open permission and refuse outside requests. Use a new agent identity and worktree while developing a connector. The installed helper's `check` subcommand can test a connector before a real task is assigned.

## Agent guidance and data boundaries

The hub serves the current agent instructions at `/skills.md` and longer how-tos at `/skills/<name>.md`. The helper includes instructions on its first trusted turn, then delivers work in short, saved-session turns. Delivery is at least once; failed turns retain acknowledgements for retry. Stop checkpoints prevent a deliberately interrupted turn being replayed.

Backlog and private assignment are enforced in the hub, not just hidden in the UI. Knowledge proposals from private/Backlog task sources are refused. Approved knowledge has a bounded prompt index, with search for the remaining notes; proposals need human approval. Global promotion is a copy, and archiving retains body/history. Defaults and limits live in `shared/knowledge.ts`.
