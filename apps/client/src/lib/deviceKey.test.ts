import { describe, expect, test } from 'bun:test'
import { memoryKeyStore } from '../test/deviceKeyStore'
import { loadDeviceKey } from './deviceKey'

describe('loadDeviceKey', () => {
  test('makes one non-extractable key per profile and answers the same public key on every load', async () => {
    const { store, saved } = memoryKeyStore()
    const first = await loadDeviceKey(store)
    expect(saved()?.privateKey.extractable).toBe(false)
    expect(first.fingerprint).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)

    // Another page in the same profile, on a store that already holds the key.
    const reopened = await loadDeviceKey({ get: store.get, add: store.add })
    expect(reopened.signer.publicJwk).toEqual(first.signer.publicJwk)
    expect(reopened.fingerprint).toBe(first.fingerprint)
  })

  test('a key another tab saved first wins over the one this tab made', async () => {
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    const { store } = memoryKeyStore(other)
    const key = await loadDeviceKey(store)
    expect(key.signer.publicJwk).toEqual(await crypto.subtle.exportKey('jwk', other.publicKey))
  })
})
