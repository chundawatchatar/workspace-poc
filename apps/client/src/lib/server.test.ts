import { describe, expect, test } from 'bun:test'
import { type CommonServerErrorCode, defineServerContract, serverRoutes } from '@orch/shared'
import { HttpResponse, http } from 'msw'
import { z } from 'zod'
import { server } from '../test/msw'
import { callServer, ServerError, serverMutation, serverQuery } from './server'

const contract = defineServerContract({
  rename: {
    method: 'PATCH',
    path: '/api/items/:id',
    description: 'test',
    errors: { name_taken: 409 },
    input: z.object({ id: z.string(), name: z.string() }),
    output: z.object({ name: z.string() }),
  },
})

describe('callServer', () => {
  test('GETs a same-origin path without a body, and sends JSON for other methods', async () => {
    const requests: Request[] = []
    server.use(
      http.get(`*${serverRoutes.system.health.path}`, ({ request }) => {
        requests.push(request)
        return HttpResponse.json({ ok: true })
      }),
      http.patch(`*${contract.rename.path}`, ({ request }) => {
        requests.push(request)
        return HttpResponse.json({ name: 'x' })
      }),
    )
    expect(await callServer(serverRoutes.system.health, {})).toEqual({ ok: true })
    await callServer(contract.rename, { id: 'a', name: 'x' })

    const [health, rename] = requests
    expect(health?.url).toBe(`${location.origin}/api/health`)
    expect(health?.method).toBe('GET')
    expect(await health?.text()).toBe('')
    expect(rename?.url).toBe(`${location.origin}/api/items/a`)
    expect(rename?.method).toBe('PATCH')
    expect(rename?.headers.get('content-type')).toBe('application/json')
    expect(await rename?.text()).toBe('{"name":"x"}')
  })

  test('throws a ServerError with the code from an error body', async () => {
    server.use(
      http.patch(`*${contract.rename.path}`, () =>
        HttpResponse.json({ error: { code: 'name_taken', message: 'Taken.' } }, { status: 409 }),
      ),
    )
    const error = await callServer(contract.rename, { id: 'a', name: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServerError)
    expect(error).toMatchObject({ code: 'name_taken', status: 409, message: 'Taken.' })
  })

  test('throws an `internal` ServerError for a response outside the contract', async () => {
    server.use(http.get(`*${serverRoutes.system.health.path}`, () => HttpResponse.json({ ok: 'yes' })))
    await expect(callServer(serverRoutes.system.health, {})).rejects.toMatchObject({ code: 'internal' })
  })
})

// Type-level checks, enforced by `bun run typecheck`. They are never called.
export function typeChecks() {
  serverQuery(serverRoutes.system.health, {})
  // @ts-expect-error A GET endpoint can't be a mutation.
  serverMutation(serverRoutes.system.health)
  // @ts-expect-error A non-GET endpoint can't be a query.
  serverQuery(contract.rename, { id: 'a', name: 'x' })
  serverMutation(contract.rename).onError = (error) => {
    const code: 'name_taken' | CommonServerErrorCode = error.code
    // @ts-expect-error `nope` is neither declared nor common.
    const wrong: typeof error.code = 'nope'
    return [code, wrong]
  }
}
