import { z } from 'zod'

// The cloud server's own API, under `/api` on the server itself. It is a separate registry from the host's `routes`,
// which the server relays under `/m/<id>`, and from Better Auth's `/api/auth/*`. `apps/server` serves it with
// `createServerRouter`, and `apps/client` calls it with `callServer`.

/** The methods a server endpoint may use. GET never changes state; anything that does uses another method. */
export type ServerMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** Who may call an endpoint: anyone, or only a signed-in user. */
export type ServerAuth = 'public' | 'user'

/** The error codes every server endpoint can answer with, and their HTTP statuses. */
export const commonServerErrors = {
  bad_request: 400,
  unauthorized: 401,
  forbidden_origin: 403,
  not_found: 404,
  unsupported_media_type: 415,
  internal: 500,
} as const

export type CommonServerErrorCode = keyof typeof commonServerErrors

/** The body of every error response from the server API. */
export const serverErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
export type ServerErrorBody = z.infer<typeof serverErrorBody>

/** An HTTP endpoint of the server's own API. */
export interface ServerEndpoint<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> {
  method: ServerMethod
  /** The full path, under `/api/` but never under `/api/auth`. A `:name` segment is filled from the input field. */
  path: string
  /** Who calls it and why, in one sentence. */
  description: string
  /** Defaults to `'user'`, so an endpoint is only public when it says so. */
  auth?: ServerAuth
  /** The endpoint's own error codes and their HTTP statuses, on top of `commonServerErrors`. */
  errors?: Record<string, number>
  /** GET input travels in the query string, so its fields arrive as strings: use `z.coerce` for numbers. */
  input: Input
  output: Output
}

export type ServerContract = Record<string, ServerEndpoint>

/** An endpoint after `defineServerContract`, with `auth` always set. */
export type DefinedServerEndpoint<E extends ServerEndpoint> = E & {
  auth: E extends { auth: 'public' } ? 'public' : 'user'
}

export type DefinedServerContract<C extends ServerContract> = { [K in keyof C]: DefinedServerEndpoint<C[K]> }

/** A GET endpoint, the only kind `serverQuery` takes. */
export type ServerReadEndpoint = ServerEndpoint & { method: 'GET' }

/** A non-GET endpoint, the only kind `serverMutation` takes. */
export type ServerWriteEndpoint = ServerEndpoint & { method: Exclude<ServerMethod, 'GET'> }

/** What a caller passes, before the schema applies defaults. */
export type ServerEndpointInput<E extends ServerEndpoint> = z.input<E['input']>
export type ServerEndpointOutput<E extends ServerEndpoint> = z.infer<E['output']>

/** The error codes an endpoint declares itself. */
export type DeclaredServerErrorCode<E extends ServerEndpoint> = E extends { errors: infer Errors }
  ? keyof Errors & string
  : never

/** Every error code an endpoint can answer with: its own and the common ones. */
export type ServerErrorCode<E extends ServerEndpoint> = CommonServerErrorCode | DeclaredServerErrorCode<E>

/**
 * Checks a server contract and fills a missing `auth` with `'user'`. Throws
 * when a path is not under `/api/`, or is under `/api/auth` (Better Auth's) or
 * `/m/` (the relay's).
 */
export function defineServerContract<C extends ServerContract>(contract: C): DefinedServerContract<C> {
  const defined: Record<string, ServerEndpoint> = {}
  for (const [name, endpoint] of Object.entries(contract)) {
    const { path } = endpoint
    if (!path.startsWith('/api/') || path === '/api/auth' || path.startsWith('/api/auth/') || path.startsWith('/m/')) {
      throw new Error(`Server endpoint "${name}" has path ${path}, which must be under /api/ and not /api/auth.`)
    }
    defined[name] = { ...endpoint, auth: endpoint.auth ?? 'user' }
  }
  return defined as DefinedServerContract<C>
}

/**
 * The HTTP status for an error code: a common code's status, which an endpoint
 * can't change, or else the endpoint's own. Unknown codes get 500.
 */
export function serverErrorStatus(endpoint: ServerEndpoint, code: string): number {
  if (Object.hasOwn(commonServerErrors, code)) return commonServerErrors[code as CommonServerErrorCode]
  const own = endpoint.errors && Object.hasOwn(endpoint.errors, code) ? endpoint.errors[code] : undefined
  return own ?? commonServerErrors.internal
}
