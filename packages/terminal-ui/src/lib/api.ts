import { buildRequest, type Endpoint, type EndpointInput, type EndpointOutput } from '@orch/shared'
import { queryOptions } from '@tanstack/react-query'
import type { HostTransport } from '../transport'
import { getTransport } from './store'

/** A host's non-2xx answer: its `status`, and the `code` of a JSON body that has one, such as `device_not_approved`. */
export class HostApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'HostApiError'
  }
}

/** The `code` of a JSON error body, or null. */
function errorCode(detail: string): string | null {
  try {
    const parsed: unknown = JSON.parse(detail)
    return typeof parsed === 'object' && parsed && 'code' in parsed && typeof parsed.code === 'string'
      ? parsed.code
      : null
  } catch {
    return null
  }
}

/**
 * Calls a host endpoint from `routes` in `@orch/shared` and parses the response with its output schema,
 * so the result is checked at runtime, not just typed. Throws `HostApiError` on a non-2xx response, and
 * fails on a response that does not match the contract. It goes through the connected page's transport,
 * or `transport` when given, for a call made before `<TerminalUI>` connects.
 */
export async function callApi<E extends Endpoint>(
  endpoint: E,
  input: EndpointInput<E>,
  signal?: AbortSignal,
  transport: HostTransport = getTransport(),
): Promise<EndpointOutput<E>> {
  const { url, body } = buildRequest(endpoint, input as Record<string, unknown>)
  const headers = body === undefined ? undefined : { 'content-type': 'application/json' }
  const response = await transport.request(url, { method: endpoint.method, body, headers, signal })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new HostApiError(
      `${endpoint.method} ${url} failed with ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
      errorCode(detail),
    )
  }
  // `parse` checks the shape at runtime; TS can't follow `E['output']` through the generic, so name the type.
  return endpoint.output.parse(await response.json()) as EndpointOutput<E>
}

/** The query key for an endpoint, so it can be invalidated: `queryClient.invalidateQueries({ queryKey: apiKey(routes.git.status) })`. */
export function apiKey<E extends Endpoint>(endpoint: E, input?: EndpointInput<E>) {
  return input === undefined
    ? ([endpoint.method, endpoint.path] as const)
    : ([endpoint.method, endpoint.path, input] as const)
}

/**
 * Query options for a GET endpoint, typed by its contract. Spread extra options over it:
 * `useQuery({ ...apiQuery(routes.git.status, { cwd }), refetchInterval: 15_000 })`.
 */
export function apiQuery<E extends Endpoint>(endpoint: E, input: EndpointInput<E>) {
  return queryOptions({
    queryKey: apiKey(endpoint, input),
    queryFn: ({ signal }) => callApi(endpoint, input, signal),
  })
}

/** Mutation options for an endpoint, typed by its contract: `useMutation(apiMutation(routes.fs.resolveDir))`. */
export function apiMutation<E extends Endpoint>(endpoint: E) {
  return {
    mutationKey: apiKey(endpoint),
    mutationFn: (input: EndpointInput<E>) => callApi(endpoint, input),
  }
}
