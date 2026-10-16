---
name: verify
description: Verify the workspace after changes by running the TypeScript typecheck across all workspaces, the tests, and the Biome lint/format check, then summarize problems per workspace. Use after making code changes or before opening a PR.
---

Run from the repo root:

1. `bun run typecheck`: runs `tsc` in `@orch/shared`, `@orch/ui`, `@orch/host` and `@orch/web`. Note which workspace failed.
2. `bun test`: runs the `*.test.ts` files. Note each failing test and its file.
3. `bunx biome check . --max-diagnostics=100`: lint and format check.

Report the results grouped by workspace (`apps/web`, `apps/host`, `packages/shared`), with `file:line` and a one-line description for each error. Separate errors in files touched by this work from errors that already existed. The touched files are:

- Committed work: on a feature branch, `git diff --name-only main...HEAD`. On `main`, use the commits not yet pushed: `git diff --name-only @{upstream}...HEAD`.
- Uncommitted work: `git diff --name-only HEAD` plus `git ls-files --others --exclude-standard`.

If the user asked to fix the problems, run `bun run format` to apply safe Biome fixes, fix the type errors in the touched files, and run both checks again. Don't fix lint errors that already existed in files this change didn't touch.
