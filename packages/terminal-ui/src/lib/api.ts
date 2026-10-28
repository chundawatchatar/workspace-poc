import { buildRequest, type Endpoint, type EndpointInput, type EndpointOutput } from '@orch/shared'
import { queryOptions } from '@tanstack/react-query'
import { getTransport } from './store'

/**
 * Calls a host endpoint from `routes` in `@orch/shared` and parses the response with its output schema,
 * so the result is checked at runtime, not just typed. Throws on a non-2xx response or a response that
 * does not match the contract.
 */
export async function callApi<E extends Endpoint>(
  endpoint: E,
  input: EndpointInput<E>,
  signal?: AbortSignal,
): Promise<EndpointOutput<E>> {
  const { url, body } = buildRequest(endpoint, input as Record<string, unknown>)
  const headers = body === undefined ? undefined : { 'content-type': 'application/json' }
  const response = await getTransport().request(url, { method: endpoint.method, body, headers, signal })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${endpoint.method} ${url} failed with ${response.status}${detail ? `: ${detail}` : ''}`)
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
