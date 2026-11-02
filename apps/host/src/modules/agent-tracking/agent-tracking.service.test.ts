import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routes } from '@orch/shared'
import { AgentTrackingRepository } from './agent-tracking.repository'
import { createAgentTrackingRoutes } from './agent-tracking.routes'
import { AgentTrackingService } from './agent-tracking.service'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-trust-'))
  file = join(dir, 'data', 'agent-tracking.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const service = () => new AgentTrackingService(new AgentTrackingRepository(file))

describe('AgentTrackingService', () => {
  test('stores each answer in a private file of answers only, and reads it back after a restart', () => {
    const trust = service()
    expect(trust.status()).toEqual({ claude: null, codex: null })
    expect(trust.tracking()).toEqual({ claude: false, codex: false })

    trust.update({ agent: 'claude', answer: 'on' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ claude: 'on' })
    trust.update({ agent: 'codex', answer: 'off' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ claude: 'on', codex: 'off' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'data'))).toEqual(['agent-tracking.json'])

    const restarted = service()
    expect(restarted.status()).toEqual({ claude: 'on', codex: 'off' })
    expect(restarted.tracking()).toEqual({ claude: true, codex: false })
  })

  test('a corrupt file reads as never asked, which tracks nothing', () => {
    service().update({ agent: 'claude', answer: 'on' })
    for (const content of ['not json', JSON.stringify({ claude: 'yes' }), '[]']) {
      writeFileSync(file, content)
      expect(service().status()).toEqual({ claude: null, codex: null })
      expect(service().tracking()).toEqual({ claude: false, codex: false })
    }
  })

  test('listeners hear a changed answer once, and not a repeated one', () => {
    const trust = service()
    let heard = 0
    trust.onChange(() => heard++)
    trust.update({ agent: 'codex', answer: 'on' })
    trust.update({ agent: 'codex', answer: 'on' })
    expect(heard).toBe(1)
    trust.update({ agent: 'codex', answer: 'off' })
    expect(heard).toBe(2)
  })

  test('the routes answer the status and refuse an unknown agent or an extra field', async () => {
    const app = createAgentTrackingRoutes({ agentTracking: service() })
    const put = (body: object) =>
      app.request(routes.agentTracking.update.path, {
        method: routes.agentTracking.update.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await put({ agent: 'claude', answer: 'on' })).status).toBe(200)
    expect((await put({ agent: 'cursor', answer: 'on' })).status).toBe(400)
    expect((await put({ agent: 'codex', answer: 'on', token: 'x' })).status).toBe(400)
    const status = await app.request(routes.agentTracking.status.path)
    expect(await status.json()).toEqual({ claude: 'on', codex: null })
  })
})
