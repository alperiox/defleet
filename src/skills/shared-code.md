# Work from the hub's canonical repo

For projects with a seeded canonical `main`, work in a worktree of the hub repo and push your branch to the hub. Do not copy another machine's local folder or assume its main is current. When the task explicitly says never push, honor that task and attach a portable patch instead.

A project-aware device launch prepares your worktree and gives the helper the project, clean repo URL, worktree path, branch and base SHA. Keep this worktree; do not reset someone else's checkout. Dirty existing worktrees are refused so pending work is preserved. Projects without a seeded main still use the legacy local-folder flow until the human seeds them.

## Manual setup

Run `bun helper.ts git-setup <project>` inside your current repository. It configures the `fleet` remote and an environment credential helper, and prints canonical clone/worktree commands when main exists. The password is `FLEET_TOKEN`; never print it or put it in a URL, report or message. Configure that credential helper in a fresh clone too.

```sh
# After configuring fleet auth and fetching the remote:
git fetch fleet
git worktree add -b <your-agent>/<TASK-KEY>-<slug> <your-worktree> fleet/main
# Work, validate and commit in your own worktree, then:
git push fleet HEAD:refs/heads/<your-agent>/<TASK-KEY>-<slug>
```

Only your namespace is writable. Direct main pushes, tags, branch deletes, force pushes and other agents' branches are refused. Push your branch before review or handoff unless the task explicitly prohibits pushing; name its branch and full commit in the task. Read another agent's branch with `git fetch fleet` and inspect it in your own worktree.

## Human integration

The human uses Code → Integrate or `fleet integrate <project> <agent/branch>`. Main advances only by a fast-forward with a compare-and-swap guard, and the hub records an integration and room note. No agent has integration permission in v1.

If main moved, fetch it and rebase locally, resolve conflicts and validate. Push the rebased result under a **new branch name**; force pushes are refused. Ask the human to integrate that branch. Never rewrite main yourself.

## Large files and retention

Upload recordings, datasets, screenshots and logs to the task. Git rejects blobs over 25 MiB, pushes adding over 100 MiB, and repositories over their budget. Low disk space pauses writes; do not work around the guard. Merged unchanged task branches are removed after 30 days. Unmerged branches idle for 60 days are listed for the human to review, never automatically deleted. Guest/private-workspace and quarantined agents have no repo access.
