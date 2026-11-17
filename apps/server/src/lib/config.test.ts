import { describe, expect, test } from 'bun:test'
import { loadServerConfig } from './config'

const accountsEnv = {
  DATABASE_URL: 'postgres://orch:db-password@127.0.0.1:5432/orch',
  BETTER_AUTH_SECRET: 'a-dev-secret-that-is-32-bytes-ok',
  BETTER_AUTH_URL: 'http://127.0.0.1:3220',
  SMTP_URL: 'smtp://127.0.0.1:1025',
  MAIL_FROM: 'Orch <no-reply@example.com>',
  RELAY_SIGNING_KEY: `k1:${'s'.repeat(43)}`,
  SERVER_TUNNEL_URL: 'ws://127.0.0.1:4600',
}

function errorOf(env: Record<string, string | undefined>): string {
  try {
    loadServerConfig(env)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected loadServerConfig to throw')
}

describe('loadServerConfig', () => {
  test('turns accounts off without `DATABASE_URL`, whatever else is missing', () => {
    expect(loadServerConfig({ BETTER_AUTH_SECRET: 'short' })).toEqual({ accounts: null, trustedOrigins: [] })
  })

  test('turns accounts on when every accounts variable is valid', () => {
    const config = loadServerConfig({
      ...accountsEnv,
      SERVER_TRUSTED_ORIGINS: 'https://a.example, http://b:8080',
      RELAY_EXTRA_PUBLIC_KEYS: ` k2:${'p'.repeat(43)} `,
    })
    expect(config.accounts).toMatchObject({
      databaseUrl: accountsEnv.DATABASE_URL,
      mailFrom: accountsEnv.MAIL_FROM,
      relaySigningKey: { kid: 'k1', seed: 's'.repeat(43) },
      relayExtraPublicKeys: [{ kid: 'k2', publicKey: 'p'.repeat(43) }],
      serverTunnelUrl: 'ws://127.0.0.1:4600',
    })
    expect(config.trustedOrigins).toEqual(['https://a.example', 'http://b:8080'])
  })

  test('names each bad variable without printing its value', () => {
    const secret = 'x'.repeat(31)
    const message = errorOf({
      DATABASE_URL: accountsEnv.DATABASE_URL,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: 'not a url',
      SMTP_URL: 'http://127.0.0.1:1025',
      SERVER_TRUSTED_ORIGINS: 'https://ok.example,https://bad.example/',
      RELAY_SIGNING_KEY: 'relay-seed-without-a-kid',
    })
    for (const name of [
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_URL',
      'SMTP_URL',
      'MAIL_FROM',
      'SERVER_TRUSTED_ORIGINS',
      'RELAY_SIGNING_KEY',
    ]) {
      expect(message).toContain(name)
    }
    for (const value of [secret, 'not a url', 'http://127.0.0.1:1025', 'bad.example', 'db-password', 'relay-seed']) {
      expect(message).not.toContain(value)
    }
  })

  test('takes SERVER_TUNNEL_URL only as wss://<host> or ws:// on loopback, with no path, and names it otherwise', () => {
    const tunnelUrl = (value: string | undefined) =>
      loadServerConfig({ ...accountsEnv, SERVER_TUNNEL_URL: value }).accounts?.serverTunnelUrl
    expect(tunnelUrl('wss://Relay.Example.com/')).toBe('wss://relay.example.com')
    expect(tunnelUrl('ws://[::1]:4600')).toBe('ws://[::1]:4600')
    for (const value of [
      undefined,
      '',
      'ws://relay.example.com',
      'https://relay.example.com',
      'wss://relay.example.com/base',
      'wss://relay.example.com/?a=1',
      'wss://user:pass@relay.example.com',
    ]) {
      const message = errorOf({ ...accountsEnv, SERVER_TUNNEL_URL: value })
      expect(message).toContain('SERVER_TUNNEL_URL')
      if (value) expect(message).not.toContain(value)
    }
    // Accounts off need none.
    expect(loadServerConfig({ SERVER_TUNNEL_URL: 'nonsense' }).accounts).toBeNull()
  })

  test('counts bytes, not characters, for the secret', () => {
    // 16 two-byte characters are 32 bytes.
    expect(loadServerConfig({ ...accountsEnv, BETTER_AUTH_SECRET: 'é'.repeat(16) }).accounts).not.toBeNull()
  })
})
