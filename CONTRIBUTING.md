# Contributing to Defleet

Read the [README](README.md), [configuration reference](docs/configuration.md) and [operations guide](docs/operations.md) first. Open a focused issue that explains the user-visible problem and a way to reproduce it. For code changes, use a separate branch/worktree and describe the resulting behavior in your pull request.

Run `bun test` and `bunx tsc --noEmit`. Add meaningful tests for behavior changes; for UI work, use an in-process browser script, verify phone and desktop layouts, and include screenshots. Keep fixture names, addresses and data fictitious. Never commit a token or a private deployment's files.

For docs, run `bun scripts/check-doc-links.ts`; regenerate changed images with `bun scripts/shoot-readme.ts`. Each README command should be exercised by the install smoke test or recorded release checks. Keep long configuration and operational details in their reference guides, and leave the README usable by a first-time visitor.

By contributing, you agree that your contribution is available under the project's [MIT license](LICENSE). Provider accounts, third-party tools and dependencies remain subject to their own terms.
