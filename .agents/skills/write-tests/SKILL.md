---
name: write-tests
description: How to write tests in this repo with Bun's test runner — what is worth testing, where test files go, how to test React components (React Testing Library, happy-dom, user-event, MSW) and how to keep the suite small. Use when adding or changing logic or components that need tests, when asked to write, add or review tests, or to check coverage.
---

The goal is **the most coverage from the fewest tests**: high confidence, a small suite. A test earns its place by guarding a behavior that would hurt if it broke. Don't write a test just to cover lines, but make each test cover as much real code as it can:

- **Test through the real path.** A component test that renders the real component with its real hooks, store and lib code, and fakes only the network (MSW), covers all of those layers at once. A separate test per layer covers the same lines several times over.
- **One test per user flow, not per step.** "Open the password form, submit a wrong confirmation, see the error, fix it, see it saved" is one test that covers the form, its validation, the request and both outcomes.
- **Mock as little as possible.** Every mocked module is code the test no longer covers. Fake only what you must: the network (MSW), time (a fake timer) and the disk (a temp dir).
- **Use coverage to find gaps, then close them with one test.** After `bun run test:coverage`, pick the most important uncovered behavior and extend an existing flow test to reach it, before writing a new test.
- **But test each thing at the level it belongs.** A flow test covers wiring, not every branch of the logic under it. Never cover pure logic through a component render: a branchy helper gets fast input-to-output tests in `lib/`, and the component test checks only that the component uses it. Rendering a page with MSW to check a label or a filter makes the suite slow and flaky.

## Levels

| Level | What it covers | Faked | Rendered | How many |
|---|---|---|---|---|
| Unit | One function, hook or component, all its branches | Everything external; never the network | Nothing, or the one component with a minimal wrapper | Many, fast |
| Integration | A boundary: API response to UI, form submit to request, an error from the server shown to the user, a component wired into a feature | The network only, with MSW | The boundary component, not the whole page | Few |

- **Shared components are tested once, where they live.** `@orch/ui` (`Menu`, `Toast`, the form fields) gets thorough tests of its states, keys and callbacks in `packages/ui`. Code that uses them tests only its own wiring (the right items, the right callback), never the shared component's behavior again.
- **Hooks:** extract the logic into a pure function and unit-test that. Test a hook directly with `renderHook` only when its React behavior (effects, subscriptions, cleanup) is the point.

## Running

- `bun run test` runs every workspace's tests, each from its own folder, so each picks up its own `bunfig.toml`. `bun test <path or name>` inside a workspace (`cd apps/client && bun test SessionsTable`) runs a subset.
- Run a browser workspace's tests from inside it. From the repo root its DOM preload isn't loaded, and component tests fail with `document is not defined`.
- `bun run test:coverage` prints per-file line and function coverage. Use the uncovered line numbers to find **untested behavior**, not to chase 100%.
- Tests are typechecked by `bun run typecheck` along with the source.

## Which tool

| Code under test | Where | Tools |
|---|---|---|
| React components | `apps/client`, `packages/ui`, `packages/terminal-ui` | React Testing Library, `@testing-library/user-event`, `@testing-library/jest-dom`, on happy-dom |
| Browser code that calls the API (`apps/client/src/lib`) | `apps/client` | MSW handlers for the requests, plain `bun:test` assertions |
| Pure logic (reducers, helpers, stores) | any workspace | plain `bun:test` |
| Servers, database, PTYs, protocol | `apps/server`, `apps/host`, `apps/ptyd-bun`, `packages/domain`, `packages/terminal`, `packages/shared` | plain `bun:test`, against real servers, PGlite and temp dirs |

Only the three browser workspaces load happy-dom and Testing Library, through the `preload` in their own `bunfig.toml`. Never add the DOM, MSW or Testing Library to a server-side workspace: happy-dom replaces `fetch`, `Request`, `Response` and `WebSocket` with browser versions, and MSW intercepts requests, which would break tests that talk to real servers.

## What to test

Test, in this order of value:

1. **Pure logic with branches**: the reducer in `packages/shared/src/model.ts`, helpers in `packages/terminal-ui/src/lib/` (`tabOrder.ts`, layout math in `commands.ts`), and host logic that doesn't need a live PTY.
2. **What a user does with a component**: a menu opens, moves with the arrow keys and closes on Escape; a button opens a form; a confirmation asks before acting; an error shows and clears; focus lands where the next step needs it.
3. **Edge cases a user can hit**: closing the last tab, clamping, empty or corrupt input, unknown ids, a failed request.
4. **Contracts other code relies on**, such as "returns the same object when nothing changed" (React and the host depend on it to skip work).

Don't test:

- How a component looks: classes, colours, sizes, positions. happy-dom has no layout. Check appearance in the running app (the `run` skill).
- A component that only renders its props with no behavior, such as `BrandMark` or a static card.
- Library behavior we didn't write, such as Base UI's focus handling or TanStack's routing. Test our use of it once (the menu has the right items and they act), not the library.
- Thin wrappers, re-exports, constants, or code that only forwards to a library.
- Real shells or sockets (`apps/host/src/sessions.ts`, `index.ts`). If logic in there needs a test, extract it into a pure function first.
- The same behavior twice through different entry points.

## How many

- About **one test per behavior**, not one per function or branch. Several `expect`s in one test are fine when they check one behavior.
- For a component, one test per user flow (open, act, see the result), not one per prop or state.
- Before adding a test, check the existing file. Extend a nearby test, or skip yours if an existing one already covers the behavior.
- A bug fix gets one regression test that fails without the fix.
- If a change needs more than about five new tests, the code probably wants splitting, or the tests are covering implementation details.

## Writing them

- Put the test next to the source: `foo.ts` gets `foo.test.ts`, `Foo.tsx` gets `Foo.test.tsx`. Import `describe`, `test`, `expect` from `bun:test`.
- One `describe` per unit under test. Test names state the behavior in plain words: `'surface.close collapses an emptied pane into its sibling'`, `'Change password opens the form and Cancel closes it'`.
- Build state with the real factories (`makeSurface`, `makePane`, `makeWorkspace`) and a small `setup()` in the file. No shared fixture files and no snapshots.
- Assert on the result (`toEqual`, `toMatchObject`, `toBe` for identity), not on how it was produced. Avoid mocks. If something needs mocking, it is usually better tested at a pure seam.
- Files on disk go in a `mkdtempSync(join(tmpdir(), …))` directory, removed in `afterEach`. Never touch `apps/host/.data`.
- Follow the repo style (Biome, `import { type X }`), and add comments only where the setup isn't obvious (see the `comment` skill).

## React components

The workspace's preload (its own `test/happydom.ts`, then the shared `@orch/test-setup/react` from `packages/test-setup`) registers happy-dom, adds the `jest-dom` matchers to `expect`, runs `cleanup()` after each test, and **fails any test that logs to `console.error` or `console.warn`**, so React warnings (`act(…)`, missing keys, bad props) are fixed, not ignored. A test file needs no setup of its own.

```tsx
import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('SecuritySettings', () => {
  test('Change password opens the form and Cancel closes it', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SecuritySettings />)

    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(screen.getByLabelText('Current password')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })
})
```

- **Render** with `render()`, or in `apps/client` with `renderWithProviders()` from `src/test/render.tsx`, which wraps the component in a fresh `QueryClient` (retries off) and a memory router. Seed data with `queryClient.setQueryData` when the test is about what's shown, not about loading it.
- **Find elements the way a user does**, in this order: `getByRole` with its `name`, `getByLabelText`, `getByText`. Use `getByTestId` only when nothing a user perceives identifies the element, and never query by class or tag. If you can't find a control by role and name, that is an accessibility bug to fix in the component, not a reason to add a test id.
- **Act with `user-event`** (`const user = userEvent.setup()`, then `await user.click`, `user.type`, `user.keyboard('{ArrowDown}{Enter}')`), not `fireEvent`. It sends the full event sequence a browser would (pointer, focus, key), which Base UI's menus need.
- **Wait for async results** with `await screen.findBy…` or `await waitFor(…)`, never a fixed `setTimeout`. Wait only where something is really async: a `findBy` on a result that is already on screen just slows the test. Keep side effects out of a `waitFor` callback, since it runs many times, and never combine `waitFor` with `expect.assertions(n)`, whose count changes with the retries.
- **Assert what the user sees**: `toBeInTheDocument()`, `toHaveAccessibleName()`, `toBeDisabled()`, `toHaveFocus()`, `toHaveTextContent()`. Use `queryBy…` with `.not.toBeInTheDocument()` for something that must be gone.
- **Portals are fine.** Menus and toasts render into `document.body`, and `screen` queries the whole document, so find them through `screen`, not through the `container` that `render` returns.
- **Toasts** come from the shared store: render `<Toaster />` next to the component under test and find the message with `screen.findByRole('alert')` (error) or `'status'` (info).

## API calls (MSW)

Fake the network, not our modules. In `apps/client`, `src/test/msw.ts` exports a `server` that the preload starts before the tests (`onUnhandledRequest: 'error'`, so an unexpected request fails the test), resets after each test and closes at the end.

```ts
import { http, HttpResponse } from 'msw'
import { server } from '../test/msw'

test('a failed sign-out shows the error toast and stays on the page', async () => {
  server.use(http.post('*/api/auth/sign-out', () => HttpResponse.json({ code: 'internal' }, { status: 500 })))
  // render, click Sign out, then:
  expect(await screen.findByRole('alert')).toHaveTextContent('Signing out failed. Try again.')
})
```

- Put a handler in the test with `server.use(…)` so each test shows the responses it depends on. Add a default handler to `src/test/msw.ts` only when most tests need the same answer, such as a signed-in `get-session`.
- Match the paths the code really calls: `serverRoutes` paths under `/api` and Better Auth's `/api/auth/*`. Never hard-code a host.
- Answer with the shapes the server really returns (the `serverRoutes` Zod schemas, Better Auth's JSON), so a test can't pass against a response the server would never send.
- Never put a real token, key or password in a handler; use obvious fakes (`'t1'`, `'u1'`).
- MSW belongs to integration tests only. If a unit test seems to need it, the code under test is doing two jobs: split the request from the logic and test the logic alone.

## Lint

Biome refuses `@happy-dom/*`, `@testing-library/*` and `msw` imports in the server-side workspaces (`apps/server`, `apps/host`, `apps/ptyd-bun`, `packages/domain`, `packages/shared`, `packages/terminal`). It checks test files and test helpers (`*.test.ts`, `*.test.tsx`, anything under a `test/` folder) with the built-in test rules (no focused, skipped or nested-too-deep suites, no duplicate hooks, no `done` callbacks) and with the GritQL plugins in `biome-plugins/`:

- `no-snapshots`: no `toMatchSnapshot` or inline snapshots. A snapshot asserts "nothing changed", not a behavior, and gets updated without being read.
- `no-fire-event`: use `user-event`, which sends the full event sequence a browser would.
- `no-dom-queries`: no `getByTestId` and friends, no `container.querySelector`. Query by role, label or text.
- `no-assertion-count`: no `expect.assertions` or `expect.hasAssertions`. Assert on results; with `waitFor` the count is flaky.
- `no-static-render`: no `renderToStaticMarkup` or `renderToString`. An HTML string runs no effects or events and can only be matched with regexes; render with Testing Library's `render`.

Silence one only with a `// biome-ignore` that gives a real reason.

## Before finishing

Run `bun run test` and `bun run typecheck`. Tell the user which behaviors the new tests cover, and which ones you deliberately left untested.
