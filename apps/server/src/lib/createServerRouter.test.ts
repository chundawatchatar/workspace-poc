import { describe, expect, mock, test } from 'bun:test'
import { defineServerContract } from '@orch/shared'
import { z } from 'zod'
import {
  type Authenticate,
  createServerRouter,
  type ForUser,
  type ServerRouterOptions,
  type UserData,
} from './createServerRouter'
import { SECURITY_HEADERS } from './security'

const contract = defineServerContract({
  read: {
    method: 'GET',
    path: '/api/items/:id',
    description: 'test',
    auth: 'public',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
  },
  rename: {
    method: 'POST',
    path: '/api/items/:id/rename',
    description: 'test',
    errors: { name_taken: 409 },
    input: z.object({ id: z.string(), name: z.string().min(1) }),
    output: z.object({ id: z.string(), name: z.string(), by: z.string() }),
  },
})

const signedIn: Authenticate = () => ({ userId: 'u1', email: 'u1@test.example', name: 'U1' })
// The handlers here never touch the repositories; identity shows where `data` came from.
const userData = {} as UserData
const forUser: ForUser = () => userData

function setup(options: ServerRouterOptions = { authenticate: signedIn, forUser }) {
  const rename = mock(async (input: { id: string; name: string }, ctx: { principal: { userId: string } }) => {
    return { ...input, by: ctx.principal.userId }
  })
  const router = createServerRouter(
    contract,
    { read: async ({ id }) => ({ id }), rename },
    { onError: () => {}, ...options },
  )
  return { router, rename }
}

const sameSite = { host: 'srv.test', origin: 'http://srv.test', 'content-type': 'application/json' }

function post(router: ReturnType<typeof setup>['router'], headers: Record<string, string>, body = '{"name":"x"}') {
  return router.request('/api/items/a1/rename', { method: 'POST', headers, body })
}

async function errorOf(response: Response) {
  return { status: response.status, code: ((await response.json()) as { error: { code: string } }).error.code }
}

describe('createServerRouter', () => {
  test('passes the path params, the body and the principal to the handler', async () => {
    const { router } = setup()
    const response = await post(router, { ...sameSite, 'content-type': 'application/json; charset=utf-8' })
    expect(await response.json()).toEqual({ id: 'a1', name: 'x', by: 'u1' })
  })

  test('refuses a non-GET request without a same-site or trusted Origin, before checking the content type', async () => {
    const { router, rename } = setup({ authenticate: signedIn, forUser, trustedOrigins: ['https://app.test'] })
    const plain = { host: 'srv.test', 'content-type': 'text/plain' }
    for (const origin of [undefined, 'null', 'https://evil.test', 'http://srv.test.evil.test']) {
      const headers = origin === undefined ? plain : { ...plain, origin }
      expect(await errorOf(await post(router, headers))).toEqual({ status: 403, code: 'forbidden_origin' })
    }
    expect((await post(router, { ...sameSite, origin: 'https://app.test' })).status).toBe(200)
    expect(rename).toHaveBeenCalledTimes(1)
  })

  test('refuses a non-GET body that is not JSON', async () => {
    const { router, rename } = setup()
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const response = await post(router, { ...sameSite, 'content-type': type })
      expect(await errorOf(response)).toEqual({ status: 415, code: 'unsupported_media_type' })
    }
    expect(await errorOf(await post(router, sameSite, '{"name":""}'))).toEqual({ status: 400, code: 'bad_request' })
    expect(await errorOf(await post(router, sameSite, 'not json'))).toEqual({ status: 400, code: 'bad_request' })
    expect(rename).not.toHaveBeenCalled()
  })

  test('serves a GET endpoint for GET and HEAD only', async () => {
    const { router } = setup()
    expect(await (await router.request('/api/items/a1')).json()).toEqual({ id: 'a1' })
    expect((await router.request('/api/items/a1', { method: 'HEAD' })).status).toBe(200)
    expect((await router.request('/api/items/a1', { method: 'POST', headers: sameSite, body: '{}' })).status).toBe(404)
  })

  test('answers 401 on a user endpoint without a hook or when the hook finds nobody', async () => {
    for (const options of [{}, { authenticate: () => null }]) {
      const { router, rename } = setup(options)
      expect(await errorOf(await post(router, sameSite))).toEqual({ status: 401, code: 'unauthorized' })
      expect(rename).not.toHaveBeenCalled()
    }
  })

  test('gives a user handler only the principal, its scoped data, `fail` and `c`, and a public one no data', async () => {
    const seen: Record<string, Record<string, unknown>> = {}
    const opened = mock(forUser)
    const router = createServerRouter(
      contract,
      {
        read: async ({ id }, ctx) => {
          seen.read = { ...ctx }
          return { id }
        },
        rename: async (input, ctx) => {
          seen.rename = { ...ctx }
          return { ...input, by: ctx.principal.userId }
        },
      },
      { authenticate: signedIn, forUser: opened, onError: () => {} },
    )
    expect((await router.request('/api/items/a1')).status).toBe(200)
    expect(seen.read).toMatchObject({ principal: null, data: null })
    expect(opened).not.toHaveBeenCalled()

    expect((await post(router, sameSite)).status).toBe(200)
    expect(Object.keys(seen.rename ?? {}).sort()).toEqual(['c', 'data', 'fail', 'principal'])
    expect(seen.rename?.principal).toEqual({ userId: 'u1', email: 'u1@test.example', name: 'U1' })
    expect(seen.rename?.data).toBe(userData)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened.mock.calls[0]?.[0]).toBe(seen.rename?.principal as never)
  })

  test('fails closed with 500 when a user endpoint has a principal but no `forUser`, or authenticating throws', async () => {
    const failing: Authenticate = () => {
      throw new Error('database is down')
    }
    for (const options of [{ authenticate: signedIn }, { authenticate: failing, forUser }]) {
      const errors: unknown[] = []
      const { router, rename } = setup({ ...options, onError: (_endpoint, error) => errors.push(error) })
      expect(await errorOf(await post(router, sameSite))).toEqual({ status: 500, code: 'internal' })
      expect(rename).not.toHaveBeenCalled()
      expect(errors).toHaveLength(1)
    }
  })

  test('turns a declared error into its status and any other error into a generic 500', async () => {
    const router = createServerRouter(
      contract,
      {
        read: async () => {
          throw new Error('db password is hunter2')
        },
        rename: async (_input, { fail }) => fail('name_taken', 'That name is taken.'),
      },
      { authenticate: signedIn, forUser, onError: () => {} },
    )
    const taken = await post(router, sameSite)
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: { code: 'name_taken', message: 'That name is taken.' } })

    const broken = await router.request('/api/items/a1')
    const text = await broken.text()
    expect(broken.status).toBe(500)
    expect(JSON.parse(text).error.code).toBe('internal')
    expect(text).not.toContain('hunter2')
    for (const response of [taken, broken]) {
      expect(response.headers.get('cache-control')).toBe('no-store')
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name)).toBe(value)
    }
  })
})

// Type-level checks, enforced by `bun run typecheck`. They are never called.
export function typeChecks() {
  // @ts-expect-error `rename` has no handler.
  createServerRouter(contract, { read: async ({ id }) => ({ id }) })
  createServerRouter(contract, {
    read: async ({ id }) => ({ id }),
    // @ts-expect-error `by` is missing from the output.
    rename: async ({ id, name }) => ({ id, name }),
  })
  createServerRouter(contract, {
    read: async ({ id }) => ({ id }),
    // @ts-expect-error `rename` doesn't declare `gone`.
    rename: async (_input, { fail }) => fail('gone'),
  })
}
