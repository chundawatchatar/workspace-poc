import { setupServer } from 'msw/node'

/**
 * The fake network for every test in `apps/client`. A test adds the answers it depends on with `server.use(...)`;
 * the preload (`test/network.ts`) starts it, drops those answers after each test and fails any request without one.
 */
export const server = setupServer()
