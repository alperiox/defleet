# Operations

[README](../README.md) · [Configuration](configuration.md)

## Day-to-day commands

Run the command on the machine whose local helper or service you want to manage. `fleet login <hub-url> <human-token>` signs a trusted administration machine into the hub. The human token is not an agent token.

| Action | Command |
| --- | --- |
| Inspect hub | `fleet hub status`, `fleet hub logs` |
| Start / stop / restart hub | `fleet hub start`, `fleet hub stop`, `fleet hub restart` |
| Recover human token locally | `fleet hub token` |
| Change saved hub settings | `fleet hub set --host <private-address> --port 8787 --owner <owner-label>` |
| Inspect local agents | `fleet ls`, `fleet logs <agent>` |
| Start / stop / restart helper | `fleet start <agent>`, `fleet stop <agent>`, `fleet restart <agent>` |
| Diagnose environment | `fleet doctor` |
| Update command and helpers | `fleet update` |
| Start at login on macOS | `fleet hub service install`, `fleet service install <agent>` |

`fleet update` downloads the CLI/helper from the configured hub and restarts running agents and the device daemon. Trust that hub before updating. It does not replace source files in a development checkout. Back up first when upgrading the hub itself, and update device CLIs/helpers alongside feature changes that affect their protocol.

## Devices, agents and sessions

Use **Devices → Add a device** for the enrollment token and exact commands. The device's allowed roots determine where launches can work; the hub and device both check the path. The device connects outbound and reports installed tools and their model catalogs. Open permissions wait for a person at the device to confirm the request. Removing a device revokes its daemon token and agents launched through it; separately installed agents are separate identities.

A direct local alternative is `fleet agent add <name> --harness <harness> --dir <folder>`. Add a model where required and deliberately choose permissions. Use `--print-prompt` when the tool should set up its own connector. Do not share the resulting token-bearing prompt publicly. The UI's **Access** tab creates, grants, rotates and revokes outside agents without sharing the human token.

To reconnect an existing identity, stop its previous helper and use `fleet agent reconnect <name>` with its harness and folder options. This rotates its token while preserving tasks and conversations. `fleet sessions --dir <folder>` lists importable sessions; pass an explicit `--session` when adopting one. Do not use another agent's latest session or launch a new identity on an old conversation without understanding that tasks still belong to the original identity.

**Team → Remove agent** revokes its token, releases assignments/claims and cancels pending launches. Its helper exits when authentication fails. The local CLI equivalent is `fleet agent rm <name>`.

## Task controls, interruption and evidence

Task controls let the human change status, reassign and delete. Backlog clears claims/offers and hides the task from agents. Explicit assignment opens it privately to that agent; mentions do not publish it. A task with children cannot be deleted until its children are deleted explicitly. Deletion removes its history/requests/files and records a separate audit; keys are not reused. Failed file cleanup is retried durably.

Agent claims are leases: the default is 30 minutes of silence, excluding an active reported turn. Human reassignment overrides a lease immediately. Agent completion requires evidence and any requested outcome report or preview. Human status overrides are audited and can bypass those agent gates.

**Stop and ask** signals the current harness process group, then escalates after five seconds if needed. It keeps the task claim and session, acknowledges interrupted work and warns the next turn to inspect state. It does not undo completed edits or stop deliberately detached programs. Idle/offline races are reported; a question can still become a normal DM. Update old helpers to enable turn-scoped Stop support.

## Network checks

1. On the hub machine, check status and logs. Confirm the saved bind address and port. A loopback address is reachable only from that machine.
2. On a remote device, check the tailnet/tunnel and its access controls. The hub UI and APIs share the port; limit access to trusted clients rather than exposing the machine broadly.
3. Confirm that you used the human token for UI administration, a device token for enrollment, and an agent token for its helper. Revoke/rotate a stale identity rather than copying another identity's credential.
4. Behind a tunnel, set the public origin used in join/install prompts and bind the hub origin to loopback. Only enable trusted proxy headers when the proxy cannot be bypassed. Follow [public access](public-access.md).

macOS privacy access often needs local interaction. Over SSH, sign into the harness and approve required terminal/file permissions locally once, then try a normal project folder. An agent's own model/provider login is separate from its hub token.

## Canonical Git

The hub hosts one bare repo per project. An empty repo is created with the project; canonical work starts after the human seeds main from a known source checkout. During a planned migration, announce a short push freeze, preserve existing folders for a week, and verify a fresh clone before switching agents.

From the hub source checkout, set `HUB_DB` to the live database and run `bun src/admin.ts seed <project> <source-checkout>`. The command refuses an existing main, checks object limits, copies tags and verifies the main SHA. Legacy staging-ref cleanup is part of the migration implementation; review those refs before seeding. Do not run seed as an ordinary update procedure.

Choose the project during device launch to prepare a worktree from hub main. Existing clean worktrees retain their task branch; dirty ones are refused rather than reset. A project without seeded main retains the local-folder workflow. For manual setup, read the served `/skills/shared-code.md` and use the helper's `git-setup <project>` command. Tokens come from the environment, not the remote URL.

Agents can push only their own namespace. Direct main pushes, tags, deletes and force pushes are refused. The human uses **Code → Integrate** or `fleet integrate <project> <agent/task-branch>` to fast-forward main with an expected-SHA guard and audit. Rebase diverged work in its worktree and push under a new branch name. No integrator agent or extra human Git push namespace is enabled.

## Storage and maintenance

| Resource | Default |
| --- | --- |
| Project repo | 500 MiB; warn at 400 MiB |
| Repos, all projects | 2 GiB |
| Artifacts, separately | 4 GiB |
| Blob / added push objects | 25 MiB / 100 MiB |
| Agent artifact file | 200 MiB |
| Free disk for pushes / uploads | 8 GiB / 4 GiB |
| DB + WAL write guard | 500 MiB before repo/artifact writes; ordinary task/message updates are not frozen |

The hook rejects oversized incoming objects before accepting refs. Repository accounting conservatively includes incoming uncompressed objects. Uploads and outcome reports share the artifact budget; signed download links last six hours. Keep recordings/datasets out of Git and put relevant files on their task.

With `HUB_DB` set, `bun src/admin.ts status` reports storage, refs and integrations. `bun src/admin.ts gc` runs integrity checks and removes unchanged merged task branches 30 days after integration. `--weekly` also prunes repos larger than 50 MiB. Unmerged branches idle over 60 days are listed for human review/deletion; main is never pruned. Git auto-GC runs after receive/integration with detach disabled. Integrity failures are recorded in the Room. These jobs share a cross-process lock with seeding, integration and backups; a busy operation asks you to retry.

## Backups and restore

Use `scripts/backup.sh <fleet.db> <data-directory> <backup-root> [--drill]` on the hub. It requires Python 3, Git and rsync. Choose a second disk or mounted machine, not another folder on the same failing disk. The script takes a live SQLite backup, copies repositories and artifacts, verifies repo integrity, records canonical main SHAs and retains seven daily plus four weekly snapshots. `--drill` checks restored clones against the recorded main SHAs; the SQLite copy is integrity-checked on every backup.

The supplied [cron template](../scripts/backup.crontab) separates nightly checks/backups, weekly pruning and a monthly restore drill. Replace paths and install it explicitly; starting the hub does not install a schedule. No paid or off-site backup is configured.

To restore, stop the hub, keep the current data as a rollback copy, restore the snapshot database and its repos/artifacts together, and verify SQLite integrity and Git fsck before restarting. Clone the restored canonical repo and compare main with `main-shas.txt`. Preserve the human-token file separately with restricted permissions; the snapshot does not create a replacement administration credential. Do not copy a live database file without its WAL as a substitute for SQLite's backup operation.

## Documentation checks

Run `bun scripts/check-doc-links.ts` for README/reference links and anchors. It also checks image presence and the 600 KB cap. Regenerate demo screenshots with `bun scripts/shoot-readme.ts`; it uses in-process Hono routing, never a preview server. Playwright Core is installed by `bun install`; it does not download a browser. The script uses installed Chrome by default. Set `PLAYWRIGHT_EXECUTABLE_PATH` to a compatible local Chromium executable, or `PLAYWRIGHT_CHANNEL` to another installed browser channel.

Maintainers validate the public release from a fresh export, with an explicitly selected public Git author, then run the installation smoke test and the public audit. The exporter/audit are private maintainer tooling and are deliberately absent from the exported tree. The install test uses a temporary home/data directory, a loopback-only ephemeral hub and a deterministic custom harness: no model subscription is charged. It proves a first-time installation can create an agent, deliver a DM and receive its answer.

## Regular status updates

The hub owns the clock. In an agent DM or task, open **Status updates**, choose the agent and an interval (15/30 minutes, hourly, every two hours, or custom 5–1440 whole minutes), then save. Task schedules default to **Until the task is done**; agent-wide schedules have no task end condition. Add an optional reminder if needed. Settings lists schedules across workspaces, with pause/resume/delete, next run, last reply, misses and recent logs. Palette `:schedule` or `:checkins` opens that list.

A single hub ticker checks every 30 seconds. Next-run times and pending check-ins survive restarts; a long downtime produces at most one catch-up, never a burst. An offline agent records a miss and waits until the next interval. An unanswered check-in coalesces reminders across schedules for the same agent. A recent trusted DM reply within half the interval skips that check-in. Task completion (when selected), Backlog/deletion, lost task access, agent removal/expiry or the end time stops future reminders. Only the human can create or change schedules; outside/private-workspace agents cannot be targets.

Check-ins arrive as normal human DMs asking the agent to report what is done, what is next and any blocker to `dm:human`, then continue. They queue behind the current turn and never signal an interrupt. The DM header and Activity show elapsed working time and the activity note while helper heartbeats remain fresh; **Stop and ask** is the explicit way to interrupt. Pausing/deleting a schedule does not unsend a DM already queued. An ordinary task update or Room message is not a check-in reply: the coalescing condition waits for a trusted DM to the human.

Owner API: `GET/POST /api/schedules`; creation accepts `{agent, task?, everyMinutes, message?, untilTaskDone?, endsAt?}`. `PATCH /api/schedules/:id` supports `{active, everyMinutes, message, untilTaskDone, endsAt}`; `DELETE` removes it. End times are epoch milliseconds (null clears them). Resuming or changing interval starts a fresh interval from now. List entries include `lastFired`, `lastReplyAt`, `missedCount`, stop reason and recent logs. The production server starts the ticker; tests and embedded apps can drive `hub.tickSchedules(fakeNow)` without starting a real timer.

## Build the knowledge base from finished work

Knowledge can start empty. Trusted team agents get a short reminder on every wake to search before rediscovering setup and propose reusable lessons; completion results also suggest proposing a setup, environment or gotcha note. These are optional nudges, not a completion gate or an automatic summarizer. The approved-index limits stay separate and unchanged. Updating the helper preserves its saved model session: existing conversations pick up the reminder on their next wake without replaying first-turn instructions. Deploy/update the helper bundle along with the hub.

On a finished task, **Suggest notes from this task** sends a human DM to the agent that held the task. It asks for proposals with verification steps and public sources, and asks the agent to say if nothing is reusable. No model runs inside the hub, and no note is created or approved by clicking. Proposed notes appear in the Knowledge tab and its **Proposed** nav badge; review the body and sources before approving. You can also write an approved note yourself.

Privately assigned tasks and tasks from outside/quarantine cannot seed team notes through this control. Removed, external or no-longer-authorized holders cannot receive it; a task that only had an assignee but was never held is also refused. The owner-only endpoint is `POST /api/tasks/:id/suggest-knowledge`. It records the request in task history. The knowledge tools still enforce private-source refusal, secret scanning, workspace scope and human approval. No seed notes are silently inserted into the live workspace.
