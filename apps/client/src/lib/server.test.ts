import { afterEach, describe, expect, test } from 'bun:test'
import { type CommonServerErrorCode, defineServerContract, serverRoutes } from '@orch/shared'
import { z } from 'zod'
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

const realFetch = globalThis.fetch
const calls: { url: string; init: RequestInit }[] = []

/** Replaces `fetch` with one that records the call and answers `body` with `status`. */
function answer(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Response.json(body, { status })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  calls.length = 0
})

describe('callServer', () => {
  test('GETs a same-origin path without a body, and sends JSON for other methods', async () => {
    answer(200, { ok: true })
    expect(await callServer(serverRoutes.system.health, {})).toEqual({ ok: true })
    expect(calls[0]).toMatchObject({ url: '/api/health', init: { method: 'GET', body: undefined } })

    answer(200, { name: 'x' })
    await callServer(contract.rename, { id: 'a', name: 'x' })
    expect(calls[1]).toMatchObject({
      url: '/api/items/a',
      init: { method: 'PATCH', body: '{"name":"x"}', headers: { 'content-type': 'application/json' } },
    })
  })

  test('throws a ServerError with the code from an error body', async () => {
    answer(409, { error: { code: 'name_taken', message: 'Taken.' } })
    const error = await callServer(contract.rename, { id: 'a', name: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServerError)
    expect(error).toMatchObject({ code: 'name_taken', status: 409, message: 'Taken.' })
  })

  test('throws an `internal` ServerError for a response outside the contract', async () => {
    answer(200, { ok: 'yes' })
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
