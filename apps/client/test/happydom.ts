import { afterEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Unlike `packages/terminal-ui`, this keeps happy-dom's `fetch`, `Request`, `Response` and `WebSocket`: no test here
// talks to a real server, MSW (`network.ts`) intercepts them, and Bun's `Request` drops `credentials`, which the
// tests check. Bun's `AbortController` and `AbortSignal` are put back after registering, since MSW hands a signal to
// Bun's `BroadcastChannel` when a socket opens, which refuses happy-dom's.
const { AbortController, AbortSignal } = globalThis

// The page's URL stands in for the client's origin, so `location.origin` (the Better Auth client's `baseURL`, fixed
// on first use), relative `fetch` paths and `localStorage` work as in the browser. It loads no stylesheet or script
// files and reports them loaded, so the root route's `<link rel="stylesheet">` never holds up a render.
GlobalRegistrator.register({
  url: 'http://localhost:3220',
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
    handleDisabledFileLoadingAsSuccess: true,
  },
})

Object.assign(globalThis, { AbortController, AbortSignal })

// Every test file shares this one page, so storage is emptied after each test and nothing leaks between them.
afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
