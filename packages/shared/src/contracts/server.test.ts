import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { buildRequest } from './contract'
import { serverRoutes } from './index'
import { defineServerContract } from './server'

const endpoint = (path: string) => ({
  method: 'GET' as const,
  path,
  description: 'test',
  input: z.object({}),
  output: z.object({}),
})

describe('defineServerContract', () => {
  test('makes an endpoint that names no `auth` user-only, and keeps an explicit `public`', () => {
    const contract = defineServerContract({ me: endpoint('/api/me') })
    expect(contract.me.auth).toBe('user')
    expect(serverRoutes.system.health.auth).toBe('public')
  })

  test('throws for a path outside `/api/`, or under `/api/auth` or `/m/`', () => {
    for (const path of ['/health', '/api/auth/x', '/api/auth', '/m/x/api/y']) {
      expect(() => defineServerContract({ bad: endpoint(path) })).toThrow(path)
    }
    expect(() => defineServerContract({ ok: endpoint('/api/authors') })).not.toThrow()
  })
})

describe('buildRequest', () => {
  test('sends a JSON body for every method but GET', () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect(buildRequest({ method, path: '/api/items/:id' }, { id: 'a', name: 'x' })).toEqual({
        url: '/api/items/a',
        body: '{"name":"x"}',
      })
    }
  })
})
