---
name: write-tests
description: How to write tests in this repo with Bun's test runner — what is worth testing, where test files go, and how to keep the suite small. Use when adding or changing logic that needs tests, when asked to write, add or review tests, or to check coverage.
---

The goal is confidence with as few tests as possible. A test earns its place by guarding a behavior that would hurt if it broke. Don't write a test just to cover lines.

## Running

- `bun test` runs every `*.test.ts` in the repo. `bun test <path or name>` runs a subset.
- `bun run test:coverage` prints per-file line and function coverage. Use the uncovered line numbers to find **untested behavior**, not to chase 100%.
- Tests are typechecked by `bun run typecheck` along with the source.

## What to test

Test, in this order of value:

1. **Pure logic with branches**: the reducer in `packages/shared/src/model.ts`, helpers in `apps/web/src/lib/` (`tabOrder.ts`, layout math in `commands.ts`), and host logic that doesn't need a live PTY.
2. **Edge cases a user can hit**: closing the last tab, clamping, empty or corrupt input, unknown ids.
3. **Contracts other code relies on**, such as "returns the same object when nothing changed" (React and the host depend on it to skip work).

Don't test:

- Presentational components in `packages/ui` or `apps/web/src/components`. Check UI changes in the running app instead (the `run` skill).
- Thin wrappers, re-exports, constants, or code that only forwards to a library.
- Real shells or sockets (`apps/host/src/sessions.ts`, `index.ts`). If logic in there needs a test, extract it into a pure function first.
- The same behavior twice through different entry points.

## How many

- About **one test per behavior**, not one per function or branch. Several `expect`s in one test are fine when they check one behavior.
- Before adding a test, check the existing file. Extend a nearby test, or skip yours if an existing one already covers the behavior.
- A bug fix gets one regression test that fails without the fix.
- If a change needs more than about five new tests, the code probably wants splitting, or the tests are covering implementation details.

## Writing them

- Put the test next to the source: `foo.ts` gets `foo.test.ts`. Import from `bun:test`.
- One `describe` per unit under test. Test names state the behavior in plain words: `'surface.close collapses an emptied pane into its sibling'`.
- Build state with the real factories (`makeSurface`, `makePane`, `makeWorkspace`) and a small `setup()` in the file. No shared fixture files and no snapshots.
- Assert on the result (`toEqual`, `toMatchObject`, `toBe` for identity), not on how it was produced. Avoid mocks. If something needs mocking, it is usually better tested at a pure seam.
- Files on disk go in a `mkdtempSync(join(tmpdir(), …))` directory, removed in `afterEach`. Never touch `apps/host/.data`.
- Follow the repo style (Biome, `import { type X }`), and add comments only where the setup isn't obvious (see the `comment` skill).

## Before finishing

Run `bun test` and `bun run typecheck`. Tell the user which behaviors the new tests cover, and which ones you deliberately left untested.
