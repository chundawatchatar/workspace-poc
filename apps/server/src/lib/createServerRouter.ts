import type { Principal } from '@orch/domain'
import {
  type ServerAuth,
  type ServerEndpoint,
  type ServerEndpointOutput,
  type ServerErrorCode,
  serverErrorStatus,
} from '@orch/shared'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { OriginPolicy, SECURITY_HEADERS } from './security'

/** Finds who sent a request, from its session. Null means nobody is signed in. */
export type Authenticate = (c: Context) => Promise<Principal | null> | Principal | null

/** What every server API router shares, built once in `index.ts`. */
export interface ServerRouterOptions {
  /** Exact origins, besides the server's own, that may send non-GET requests. Defaults to none. */
  trustedOrigins?: readonly string[]
  /** Required for `auth: 'user'` endpoints; without it they all answer 401. */
  authenticate?: Authenticate
  /** Receives an error a handler threw that isn't one of its codes. Defaults to `console.error`. */
  onError?: (endpoint: ServerEndpoint, error: unknown) => void
}

/** What a handler gets besides its input. */
export interface ServerHandlerContext<E extends ServerEndpoint> {
  /** Who is calling. Always set on `auth: 'user'` endpoints, and null on public ones. */
  principal: E extends { auth: 'public' } ? null : Principal
  /** Ends the request with one of the endpoint's error codes, or a common one. */
  fail(code: ServerErrorCode<E>, message?: string): never
  c: Context
}

/** Implements one endpoint. `input` is already validated against the endpoint's schema. */
export type ServerHandler<E extends ServerEndpoint> = (
  input: z.infer<E['input']>,
  ctx: ServerHandlerContext<E>,
) => Promise<ServerEndpointOutput<E>>

/** Thrown by `fail`; the router turns it into the error response. */
class ServerApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const GENERIC_MESSAGES: Record<string, string> = {
  bad_request: 'The request is not valid.',
  unauthorized: 'Sign in to continue.',
  forbidden_origin: 'Requests from this origin are not allowed.',
  not_found: 'Not found.',
  unsupported_media_type: 'Send the request body as application/json.',
  internal: 'Something went wrong on the server.',
}

/** The JSON error response every server API path answers with, `Cache-Control: no-store` and security headers set. */
export function serverErrorResponse(status: number, code: string, message = GENERIC_MESSAGES[code] ?? code): Response {
  return withApiHeaders(Response.json({ error: { code, message } }, { status }))
}

/**
 * Hono routes for a server contract from `serverRoutes` in `@orch/shared`.
 * Every endpoint needs a handler, or this doesn't compile. It fails closed:
 * a non-GET request needs a same-site or trusted `Origin` (403 otherwise) and
 * a JSON `Content-Type` (415), an `auth: 'user'` endpoint needs a principal
 * from `authenticate` (401), and input that fails the schema gets 400, all
 * before the handler runs. GET endpoints answer GET and HEAD only.
 */
export function createServerRouter<C extends Record<string, ServerEndpoint & { auth: ServerAuth }>>(
  contract: C,
  handlers: { [K in keyof C]: ServerHandler<C[K]> },
  options: ServerRouterOptions = {},
): Hono {
  const origins = new OriginPolicy(options.trustedOrigins)
  const onError = options.onError ?? ((endpoint, error) => console.error(`${endpoint.method} ${endpoint.path}:`, error))
  const router = new Hono()

  for (const [name, endpoint] of Object.entries(contract)) {
    const handler = handlers[name] as ServerHandler<ServerEndpoint>
    router.on(endpoint.method, endpoint.path, async (c) => {
      try {
        if (endpoint.method !== 'GET') checkSameSiteJson(c, origins)
        // Anything but an explicit `public` needs a principal.
        const principal = endpoint.auth === 'public' ? null : await requirePrincipal(c, options.authenticate)
        const input = await readInput(c, endpoint)
        // `principal` is null only on public endpoints, which the line above guarantees but TS can't follow.
        const ctx = { principal, fail, c } as ServerHandlerContext<ServerEndpoint>
        // Parsing strips fields the contract doesn't list, so a handler can't leak a column by returning a row.
        const output = endpoint.output.parse(await handler(input, ctx))
        return withApiHeaders(c.json(output, 200))
      } catch (error) {
        if (error instanceof ServerApiError) {
          const status = serverErrorStatus(endpoint, error.code)
          if (status !== 500 || error.code === 'internal') return serverErrorResponse(status, error.code, error.message)
        }
        onError(endpoint, error)
        return serverErrorResponse(500, 'internal')
      }
    })
  }
  return router
}

function fail(code: string, message?: string): never {
  throw new ServerApiError(code, message ?? GENERIC_MESSAGES[code] ?? code)
}

/** Refuses a non-GET request from a foreign or missing `Origin`, then one whose body isn't JSON. */
function checkSameSiteJson(c: Context, origins: OriginPolicy): void {
  // Unlike `/m/*`, a missing `Origin` is refused: browsers always send one on a non-GET `fetch`.
  const verdict = origins.check(c.req.header('origin'), c.req.header('host'))
  if (verdict !== 'same' && verdict !== 'cross') fail('forbidden_origin')
  if (!isJson(c.req.header('content-type'))) fail('unsupported_media_type')
}

async function requirePrincipal(c: Context, authenticate: Authenticate | undefined): Promise<Principal> {
  return (await authenticate?.(c)) ?? fail('unauthorized')
}

/** The query (GET) or JSON body, with the path params over it, checked against the endpoint's input schema. */
async function readInput(c: Context, endpoint: ServerEndpoint): Promise<unknown> {
  const fields = endpoint.method === 'GET' ? c.req.query() : await readJson(c)
  if (fields === undefined) fail('bad_request', 'The body is not valid JSON.')
  const input = endpoint.input.safeParse({ ...fields, ...c.req.param() })
  if (!input.success) fail('bad_request', z.prettifyError(input.error))
  return input.data
}

/** True for `application/json`, with or without parameters such as `charset`. */
function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

/** The body as a JSON object. Undefined means it isn't one. */
async function readJson(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json()
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function withApiHeaders(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store')
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value)
  return response
}
