import type { Contract, Endpoint, EndpointOutput } from '@orch/shared'
import { type Context, Hono } from 'hono'
import { z } from 'zod'

/** Implements one endpoint. `input` is already validated against the endpoint's schema. */
export type Handler<E extends Endpoint> = (input: z.infer<E['input']>, c: Context) => Promise<EndpointOutput<E>>

/**
 * Hono routes for a contract from `@orch/shared`. Every endpoint in the contract needs a
 * handler, or this doesn't compile. Input that fails the schema gets a 400 before the handler runs.
 */
export function createRouter<C extends Contract>(contract: C, handlers: { [K in keyof C]: Handler<C[K]> }): Hono {
  const router = new Hono()
  for (const [name, endpoint] of Object.entries(contract)) {
    const handler = handlers[name] as Handler<Endpoint>
    router.on(endpoint.method, endpoint.path, async (c) => {
      const fields = endpoint.method === 'GET' ? c.req.query() : await c.req.json().catch(() => ({}))
      const input = endpoint.input.safeParse({ ...fields, ...c.req.param() })
      if (!input.success) return c.json({ error: z.prettifyError(input.error) }, 400)
      return c.json(await handler(input.data, c))
    })
  }
  return router
}
