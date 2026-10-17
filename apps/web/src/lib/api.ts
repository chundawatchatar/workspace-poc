import { buildRequest, type Endpoint, type EndpointInput, type EndpointOutput } from '@orch/shared'
import { HOST_HTTP } from './store'

/** Calls a host endpoint from `routes` in `@orch/shared`, typed by its schemas. Throws on a non-2xx response. */
export async function callApi<E extends Endpoint>(endpoint: E, input: EndpointInput<E>): Promise<EndpointOutput<E>> {
  const { url, body } = buildRequest(endpoint, input as Record<string, unknown>)
  const init =
    body === undefined ? undefined : { method: endpoint.method, body, headers: { 'content-type': 'application/json' } }
  const response = await fetch(`${HOST_HTTP}${url}`, init)
  if (!response.ok) throw new Error(`${endpoint.method} ${url} failed with ${response.status}`)
  return response.json()
}
