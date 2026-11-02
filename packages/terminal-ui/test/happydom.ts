import { GlobalRegistrator } from '@happy-dom/global-registrator'

// `transport.test.ts` talks to a real `Bun.serve`, which needs Bun's own network classes, and the component tests
// never use happy-dom's, so they are put back after registering.
const { fetch, Request, Response, Headers, WebSocket } = globalThis

GlobalRegistrator.register()

Object.assign(globalThis, { fetch, Request, Response, Headers, WebSocket })
