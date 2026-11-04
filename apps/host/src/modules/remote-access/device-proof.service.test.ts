import { describe, expect, test } from 'bun:test'
import { base64url, deviceKeyFingerprint } from '@orch/terminal-ui/device-proof'
import { bodySha256 } from '../tunnel/tunnel-http.service'
import { fingerprintOf, SpentNonces, verifyDeviceProof } from './device-proof.service'
import { testDevice } from './device-proof.testing'

const now = Date.UTC(2026, 10, 4, 12)
const target = { machineId: 'm1', method: 'POST', path: '/api/git/status?cwd=%2Ftmp', body: '{"a":1}' }
const check = { machineId: 'm1', method: 'POST', path: target.path, bodySha256: bodySha256(target.body), now }

const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('verifyDeviceProof', () => {
  test('a browser-built proof verifies to the device whose fingerprint the browser shows', async () => {
    const device = await testDevice()
    const verified = verifyDeviceProof(await device.proof(target, now), check)
    expect(verified).toMatchObject({ deviceId: device.id, iat: now / 1000 })
    expect(fingerprintOf(verified?.deviceId ?? '')).toBe(await deviceKeyFingerprint(device.signer.publicJwk))
    expect(fingerprintOf(device.id)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
  })

  test('another machine, method, path or body, a far iat, a changed signature or an extra field is refused', async () => {
    const device = await testDevice()
    const proof = await device.proof(target, now)
    expect(verifyDeviceProof(proof, { ...check, machineId: 'm2' })).toBeNull()
    expect(verifyDeviceProof(proof, { ...check, method: 'GET' })).toBeNull()
    expect(verifyDeviceProof(proof, { ...check, path: '/api/git/status' })).toBeNull()
    expect(verifyDeviceProof(proof, { ...check, bodySha256: bodySha256('{"a":2}') })).toBeNull()
    expect(verifyDeviceProof(await device.proof(target, now - 301_000), check)).toBeNull()
    expect(verifyDeviceProof(await device.proof(target, now + 301_000), check)).toBeNull()
    expect(verifyDeviceProof(await device.proof(target, now - 299_000), check)).not.toBeNull()

    const [header = '', payload = '', signature = ''] = proof.split('.')
    const flipped = Buffer.from(signature, 'base64url')
    flipped[5] = (flipped[5] ?? 0) ^ 1
    expect(verifyDeviceProof(`${header}.${payload}.${flipped.toString('base64url')}`, check)).toBeNull()

    // Validly signed, but with a field the format doesn't have.
    const signed = async (h: unknown, p: unknown) => {
      const input = `${encode(h)}.${encode(p)}`
      return `${input}.${base64url(await device.signer.sign(new TextEncoder().encode(input)))}`
    }
    expect(verifyDeviceProof(await signed(decode(header), decode(payload)), check)).not.toBeNull()
    expect(verifyDeviceProof(await signed({ ...decode(header), kid: 'x' }, decode(payload)), check)).toBeNull()
    const withExtraKeyField = { ...decode(header), jwk: { ...decode(header).jwk, d: 'x' } }
    expect(verifyDeviceProof(await signed(withExtraKeyField, decode(payload)), check)).toBeNull()
    expect(verifyDeviceProof(await signed(decode(header), { ...decode(payload), sub: 'u1' }), check)).toBeNull()
    expect(verifyDeviceProof('not.a.proof', check)).toBeNull()
  })
})

describe('SpentNonces', () => {
  test('a nonce is spent once, and forgotten only after twice the skew', () => {
    const nonces = new SpentNonces()
    expect(nonces.spend('n1', now)).toBe(true)
    expect(nonces.spend('n1', now + 599_000)).toBe(false)
    expect(nonces.spend('n1', now + 601_000)).toBe(true)
  })
})
