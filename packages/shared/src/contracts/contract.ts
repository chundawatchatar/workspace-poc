import type { z } from 'zod'

// Every route the host serves is defined here, once, with its full path and
// schemas, and collected in `routes` (index.ts). The host serves them
// (`createRouter`, `<feature>.ws.ts`), and the web app and `@orch/ui` call them
// (`callApi`, `buildSocketUrl`), so no route string is written anywhere else.

export const API_PREFIX = '/api'

/** The path every WebSocket the host serves sits under. */
export const WS_PREFIX = '/ws'

/** An HTTP endpoint. */
export interface Endpoint<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> {
  method: 'GET' | 'POST'
  /** The full path, starting with `/api`. A `:name` segment is filled from the input field of the same name. */
  path: string
  /** Who calls it and why, in one sentence. */
  description: string
  /** GET input travels in the query string, so its fields arrive as strings: use `z.coerce` for numbers. */
  input: Input
  output: Output
}

/** A WebSocket. Its input is the path params and query string of the URL it is opened with. */
export interface Socket<Input extends z.ZodType = z.ZodType> {
  /** The full path, starting with `/ws`. */
  path: string
  description: string
  input: Input
  /** The JSON text frames a client may send. The host reads them with `parseMessage`. */
  clientMessage: z.ZodType
}

export type Contract = Record<string, Endpoint>

/** What a caller passes, before the schema applies defaults. */
export type EndpointInput<E extends Endpoint> = z.input<E['input']>
export type EndpointOutput<E extends Endpoint> = z.infer<E['output']>
export type SocketInput<S extends Socket> = z.input<S['input']>

export function defineContract<C extends Contract>(contract: C): C {
  return contract
}

export function defineSocket<S extends Socket>(socket: S): S {
  return socket
}

/** Parses a JSON text frame against a socket's message schema. Returns null for anything that doesn't match. */
export function parseMessage<M extends z.ZodType>(schema: M, data: unknown): z.infer<M> | null {
  if (typeof data !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}

/** Fills `:name` segments from `input` and returns the fields left over. */
function fillPath(path: string, input: Record<string, unknown>) {
  const used = new Set<string>()
  const filled = path.replace(/:(\w+)/g, (_, key: string) => {
    used.add(key)
    return encodeURIComponent(String(input[key]))
  })
  const rest = Object.entries(input).filter(([key, value]) => !used.has(key) && value !== undefined)
  return { path: filled, rest }
}

function withQuery(path: string, fields: [string, unknown][]) {
  const query = new URLSearchParams(fields.map(([key, value]): [string, string] => [key, String(value)])).toString()
  return query ? `${path}?${query}` : path
}

/** The URL and JSON body for calling an endpoint. GET requests have no body. */
export function buildRequest(endpoint: Endpoint, input: Record<string, unknown>): { url: string; body?: string } {
  const { path, rest } = fillPath(endpoint.path, input)
  if (endpoint.method === 'GET') return { url: withQuery(path, rest) }
  return { url: path, body: JSON.stringify(Object.fromEntries(rest)) }
}

/** The URL to open a socket with, without the host. */
export function buildSocketUrl<S extends Socket>(socket: S, input: SocketInput<S>): string {
  const { path, rest } = fillPath(socket.path, input as Record<string, unknown>)
  return withQuery(path, rest)
}
