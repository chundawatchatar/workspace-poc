import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { buildRequest, buildSocketUrl, defineSocket, type Endpoint, parseMessage } from './contract'

const endpoint = (method: Endpoint['method']): Endpoint => ({
  method,
  path: '/api/workspaces/:id/rename',
  description: 'test',
  input: z.object({}),
  output: z.object({}),
})

describe('buildRequest', () => {
  test('fills path params and puts the rest of a GET input in the query string', () => {
    expect(buildRequest(endpoint('GET'), { id: 'ws 1', name: 'a&b', skip: undefined })).toEqual({
      url: '/api/workspaces/ws%201/rename?name=a%26b',
    })
  })

  test('sends the rest of a POST input as the JSON body', () => {
    expect(buildRequest(endpoint('POST'), { id: 'ws1', name: 'x' })).toEqual({
      url: '/api/workspaces/ws1/rename',
      body: '{"name":"x"}',
    })
  })
})

describe('buildSocketUrl', () => {
  test('fills path params and puts the rest in the query string', () => {
    const socket = defineSocket({
      path: '/ws/term/:id',
      description: 'test',
      input: z.object({ id: z.string(), cols: z.number() }),
      clientMessage: z.object({}),
    })
    expect(buildSocketUrl(socket, { id: 't1', cols: 80 })).toBe('/ws/term/t1?cols=80')
  })
})

describe('parseMessage', () => {
  test('returns the typed message, or null for bad JSON, a wrong shape or a binary frame', () => {
    const schema = z.object({ type: z.literal('resize'), cols: z.number().int().min(2) })
    expect(parseMessage(schema, '{"type":"resize","cols":80}')).toEqual({ type: 'resize', cols: 80 })
    expect(parseMessage(schema, 'not json')).toBeNull()
    expect(parseMessage(schema, '{"type":"resize","cols":-1}')).toBeNull()
    expect(parseMessage(schema, new ArrayBuffer(4))).toBeNull()
  })
})
