import {
  buildRequest,
  type ServerEndpoint,
  type ServerEndpointInput,
  type ServerEndpointOutput,
  type ServerErrorCode,
  type ServerReadEndpoint,
  type ServerWriteEndpoint,
  serverErrorBody,
} from '@orch/shared'
import { mutationOptions, queryOptions } from '@tanstack/react-query'

/** An error answer from the server API, or a response that broke the contract (`internal`). */
export class ServerError<Code extends string = string> extends Error {
  override name = 'ServerError'

  constructor(
    /** One of the endpoint's declared codes or a common one. */
    readonly code: Code,
    message: string,
    /** The HTTP status; 0 when the response was 2xx but didn't match the contract. */
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * Calls an endpoint from `serverRoutes` in `@orch/shared` on the same origin
 * and parses the response with its output schema. Throws a `ServerError` for
 * an error answer or a response that doesn't match the contract.
 */
export async function callServer<E extends ServerEndpoint>(
  endpoint: E,
  input: ServerEndpointInput<E>,
  signal?: AbortSignal,
): Promise<ServerEndpointOutput<E>> {
  const { url, body } = buildRequest(endpoint, input as Record<string, unknown>)
  const headers = body === undefined ? undefined : { 'content-type': 'application/json' }
  const response = await fetch(url, { method: endpoint.method, body, headers, signal, credentials: 'same-origin' })
  const json: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = serverErrorBody.safeParse(json)
    if (error.success) {
      // The server only sends codes the contract lists, so trust the body's code.
      throw new ServerError(error.data.error.code as ServerErrorCode<E>, error.data.error.message, response.status)
    }
    throw new ServerError<ServerErrorCode<E>>(
      'internal',
      `${endpoint.method} ${url} failed with ${response.status}`,
      response.status,
    )
  }
  const output = endpoint.output.safeParse(json)
  if (!output.success) {
    throw new ServerError<ServerErrorCode<E>>('internal', `${endpoint.method} ${url} answered outside its contract`, 0)
  }
  return output.data as ServerEndpointOutput<E>
}

/**
 * The query key for a server endpoint, under a fixed `'server'` prefix so all
 * server data can be invalidated or cleared at once.
 */
export function serverKey<E extends ServerEndpoint>(endpoint: E, input?: ServerEndpointInput<E>) {
  return input === undefined ? (['server', endpoint.path] as const) : (['server', endpoint.path, input] as const)
}

/** Query options for a GET server endpoint: `useQuery(serverQuery(serverRoutes.system.health, {}))`. */
export function serverQuery<E extends ServerReadEndpoint>(endpoint: E, input: ServerEndpointInput<E>) {
  return queryOptions<ServerEndpointOutput<E>, ServerError<ServerErrorCode<E>>>({
    queryKey: serverKey(endpoint, input),
    queryFn: ({ signal }) => callServer(endpoint, input, signal),
  })
}

/** Mutation options for a non-GET server endpoint: `useMutation(serverMutation(serverRoutes.<feature>.<op>))`. */
export function serverMutation<E extends ServerWriteEndpoint>(endpoint: E) {
  return mutationOptions<ServerEndpointOutput<E>, ServerError<ServerErrorCode<E>>, ServerEndpointInput<E>>({
    mutationKey: serverKey(endpoint),
    mutationFn: (input) => callServer(endpoint, input),
  })
}
