import { describe, expect, test } from 'bun:test'
import { defineContract } from '@orch/shared'
import { z } from 'zod'
import { createRouter } from './createRouter'

const contract = defineContract({
  get: {
    method: 'GET',
    path: '/items/:id',
    description: 'test',
    input: z.object({ id: z.string(), limit: z.coerce.number() }),
    output: z.object({ id: z.string(), limit: z.number() }),
  },
  rename: {
    method: 'POST',
    path: '/items/:id/rename',
    description: 'test',
    input: z.object({ id: z.string(), name: z.string() }),
    output: z.object({ id: z.string(), name: z.string() }),
  },
})

const router = createRouter(contract, {
  get: async (input) => input,
  rename: async (input) => input,
})

describe('createRouter', () => {
  test('merges path params with the query (GET) or JSON body (POST) into the input', async () => {
    expect(await (await router.request('/items/a1?limit=5')).json()).toEqual({ id: 'a1', limit: 5 })
    const post = await router.request('/items/a1/rename', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    expect(await post.json()).toEqual({ id: 'a1', name: 'x' })
  })

  test('answers 400 without calling the handler when the input fails the schema', async () => {
    const response = await router.request('/items/a1?limit=many')
    expect(response.status).toBe(400)
  })
})
