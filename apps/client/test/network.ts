import { afterAll, afterEach, beforeAll } from 'bun:test'
import { server } from '../src/test/msw'

// A preload beside the DOM ones, so `bunfig.toml` lists all the setup in one place and test files need none. The
// `server` itself lives in `src/test/msw.ts`, where tests import it from.
// An unhandled request rejects its `fetch` and logs through `console.error`, which `testing-library.ts` turns into a
// failure even when the code under test swallows the rejection.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
