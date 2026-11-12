import { describe, expect, test } from 'bun:test'
import {
  createCipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  sign,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  answerBrowserHandshake,
  answerBrowserHandshakeWith,
  E2eError,
  type E2eSession,
  startBrowserHandshake,
  startBrowserHandshakeWith,
} from './e2e'

// Fixed keys for the vectors, made once with `generateKeyPairSync`.
const BROWSER_EPHEMERAL = {
  kty: 'EC',
  crv: 'P-256',
  x: 'QE24_gglZh4gO73BrfhLBspurdFf8ZCNpBs-3xyt0bE',
  y: 'Q1klQjpUF9gK9pHlmFyXiW6OZJK69GwKFzJEsIFDO4E',
  d: 'IH4pkVVcAFbn7CLzPB5JUlpdkNDO97iJ_a578gDHepI',
}
const MACHINE_EPHEMERAL = {
  kty: 'EC',
  crv: 'P-256',
  x: 'H8qr9V8w0zRFFARrjHpcV5IBS63ANnsmdErJgzD-_h8',
  y: '6F7wmZGHzf9ERgIYgXm9RlM_lIuWsQtIEo6yUMPj8tQ',
  d: 'CkO8h0k-pMQIGjhjwGAUSD06IhXvjtuLHBrQIAU08gM',
}
const DEVICE_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'E7V6IOxeLrmyiNjgECMX4p3nUNZTY9kRHKEqRjR9EtI',
  y: 'ZdDIQQJlz3EoN8wqR6-zQAO0sj3ECvBzI7rARQwV8-Q',
  d: 'mAa0oS_OMLB2GlaalpbMLseJXjuhxi33t7wYvYQS7Cw',
}
const MACHINE_KEY = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'iDufRfLcpJmr5xspNH4LKG0p8QVly7do5ayT4s0RPw4',
  d: 'Nu2veYQTYVW2BIntdmjY0GfZs4hwMX9db6WJmj-lHP8',
}

const encode = (text: string) => new TextEncoder().encode(text)
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

/** A machine key signing as the host's `MachineKey` does (node `sign`), and its id. */
function machine(jwk?: typeof MACHINE_KEY) {
  const privateKey = jwk ? createPrivateKey({ key: jwk, format: 'jwk' }) : generateKeyPairSync('ed25519').privateKey
  const publicKey = privateKey.export({ format: 'jwk' }).x ?? ''
  const id = sha256(Buffer.from(publicKey, 'base64url')).toString('base64url')
  return { id, signer: { publicKey, sign: async (data: Uint8Array) => new Uint8Array(sign(null, data, privateKey)) } }
}

/** A device key signing as the browser's `DeviceSigner` does: fresh and non-extractable, or the fixed one. */
async function device(fixed?: typeof DEVICE_KEY) {
  if (fixed) {
    const privateKey = createPrivateKey({ key: fixed, format: 'jwk' })
    const { kty, crv, x, y } = fixed
    return {
      publicJwk: { kty, crv, x, y },
      sign: async (data: Uint8Array) =>
        new Uint8Array(sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
    }
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  return {
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    sign: async (data: Uint8Array<ArrayBuffer>) =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data)),
  }
}

async function handshake() {
  const m = machine()
  const browser = await startBrowserHandshake({ machineId: m.id, device: await device() })
  const answer = await answerBrowserHandshake({ machineId: m.id, machine: m.signer, hello: browser.hello })
  return { browser: await browser.finish(answer.reply, m.signer.publicKey), machine: answer.session }
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(E2eError)
  return (error as E2eError).message
}

describe('e2e handshake and sessions', () => {
  test('both directions round-trip, and a message opens only in its own direction', async () => {
    const { browser, machine: host } = await handshake()
    const binary = Uint8Array.from({ length: 256 }, (_, i) => i)
    const aad = encode('channel 7')

    expect(await host.open(await browser.seal(encode('ls -la')))).toEqual(encode('ls -la'))
    expect(await host.open(await browser.seal(new Uint8Array()))).toEqual(new Uint8Array())
    expect(await browser.open(await host.seal(binary, aad), aad)).toEqual(binary)

    // The browser's next message has counter 2, the machine's 1: forged into the
    // other direction at the right counter, it still fails, since the key differs.
    const fromBrowser = await browser.seal(encode('x'))
    const fromHost = await host.seal(encode('y'))
    fromBrowser.set(fromHost.subarray(0, 8), 0)
    expect(await rejection(browser.open(fromBrowser))).toBe('bad message')
    expect(await browser.open(fromHost)).toEqual(encode('y'))

    const concurrent = await Promise.all([1, 2, 3].map((n) => host.seal(Uint8Array.of(n))))
    expect(await Promise.all(concurrent.map((sealed) => browser.open(sealed)))).toEqual([
      Uint8Array.of(1),
      Uint8Array.of(2),
      Uint8Array.of(3),
    ])
  })

  test('fixed ephemeral keys seal to the bytes node:crypto computes', async () => {
    const m = machine(MACHINE_KEY)
    const browser = await startBrowserHandshakeWith(
      { machineId: m.id, device: await device(DEVICE_KEY) },
      { ephemeral: BROWSER_EPHEMERAL },
    )
    const answer = await answerBrowserHandshakeWith(
      { machineId: m.id, machine: m.signer, hello: browser.hello },
      { ephemeral: MACHINE_EPHEMERAL },
    )
    const session = await browser.finish(answer.reply, m.signer.publicKey)

    const raw = (jwk: typeof BROWSER_EPHEMERAL) =>
      Buffer.concat([Buffer.of(4), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(BROWSER_EPHEMERAL.d, 'base64url'))
    const shared = ecdh.computeSecret(raw(MACHINE_EPHEMERAL))
    const deviceKey = JSON.stringify({ crv: 'P-256', kty: 'EC', x: DEVICE_KEY.x, y: DEVICE_KEY.y })
    const browserTranscript = `orch-e2e-browser\n1\n${m.id}\n${deviceKey}\n${b64(raw(BROWSER_EPHEMERAL))}`
    const machineTranscript = `orch-e2e-machine\n1\n${m.id}\n${b64(sha256(browserTranscript))}\n${b64(raw(MACHINE_EPHEMERAL))}`
    expect(browser.hello.ephemeral).toBe(b64(raw(BROWSER_EPHEMERAL)))
    expect(answer.reply.ephemeral).toBe(b64(raw(MACHINE_EPHEMERAL)))
    const salt = sha256(`${browserTranscript}\n${machineTranscript}`)

    const expected = (label: string, counter: number, plaintext: Uint8Array, aad: Uint8Array) => {
      const key = Buffer.from(hkdfSync('sha256', shared, salt, label, 32))
      const counterBytes = Buffer.alloc(8)
      counterBytes.writeBigUInt64BE(BigInt(counter))
      const cipher = createCipheriv('aes-256-gcm', key, Buffer.concat([Buffer.alloc(4), counterBytes]))
      cipher.setAAD(Buffer.concat([Buffer.from(label), Buffer.of(0), counterBytes, aad]))
      return new Uint8Array(
        Buffer.concat([counterBytes, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]),
      )
    }

    const plaintext = encode('echo hello')
    const aad = encode('aad')
    expect(await session.seal(plaintext, aad)).toEqual(expected('orch-e2e browser->machine', 0, plaintext, aad))
    expect(await session.seal(plaintext, aad)).toEqual(expected('orch-e2e browser->machine', 1, plaintext, aad))
    expect(await answer.session.seal(plaintext)).toEqual(
      expected('orch-e2e machine->browser', 0, plaintext, new Uint8Array()),
    )

    const source = readFileSync(join(import.meta.dir, 'e2e.ts'), 'utf8')
    expect(source).not.toMatch(/from '(node:|bun)|require\(/)
  })

  test('a handshake fails for a forged, misdirected or malformed message', async () => {
    const m = machine()
    const other = machine()
    const signer = await device()
    const start = () => startBrowserHandshake({ machineId: m.id, device: signer })
    const answer = (hello: unknown, by = m) => answerBrowserHandshake({ machineId: m.id, machine: by.signer, hello })
    const finishWith = async (reply: (hello: unknown) => Promise<unknown>, key = m.signer.publicKey) => {
      const browser = await start()
      return rejection(browser.finish(await reply(browser.hello), key))
    }
    const { hello } = await start()

    const otherDevice = await startBrowserHandshake({ machineId: m.id, device: await device() })
    expect(await rejection(answer({ ...hello, device: otherDevice.hello.device }))).toBe('bad signature')
    const elsewhere = await startBrowserHandshake({ machineId: other.id, device: signer })
    expect(await rejection(answer(elsewhere.hello))).toBe('bad signature')

    // Signed by another key, a key that isn't this machine's, and an answer to another hello.
    const byOther = async (h: unknown) => (await answer(h, other)).reply
    expect(await finishWith(byOther)).toBe('bad signature')
    expect(await finishWith(byOther, other.signer.publicKey)).toBe('bad signature')
    expect(await finishWith(async () => (await answer((await start()).hello)).reply)).toBe('bad signature')

    // Someone with their own device key re-signs the victim's ephemeral key. The
    // machine accepts it as that device, but the victim refuses the answer.
    const attacker = await device()
    const attackerHello = async (victim: unknown) => {
      const { ephemeral } = victim as { ephemeral: string }
      const { kty, crv, x, y } = attacker.publicJwk
      const transcript = `orch-e2e-browser\n1\n${m.id}\n${JSON.stringify({ crv, kty, x, y })}\n${ephemeral}`
      const signature = b64(await attacker.sign(encode(transcript)))
      return { v: 1, device: { kty, crv, x, y }, ephemeral, signature }
    }
    const resigned = async (victim: unknown) => {
      const accepted = await answer(await attackerHello(victim))
      expect(accepted.device.x).toBe(attacker.publicJwk.x ?? '')
      return accepted.reply
    }
    expect(await finishWith(resigned)).toBe('bad signature')

    const offCurve = b64(Uint8Array.of(4, ...new Uint8Array(64).fill(1)))
    expect(await rejection(answer({ ...hello, ephemeral: offCurve }))).toBe('bad message')
    expect(await rejection(answer({ ...hello, extra: 1 }))).toBe('bad message')
    expect(await rejection(answer({ ...hello, signature: 'AAAA' }))).toBe('bad message')
    expect(await rejection(answer({ ...hello, v: 2 }))).toBe('version')
    expect(await rejection(answer('hello'))).toBe('bad message')
    const genuine = async (h: unknown) => (await answer(h)).reply as Record<string, unknown>
    expect(await finishWith(async (h) => ({ ...(await genuine(h)), v: 2 }))).toBe('version')
    expect(await finishWith(async (h) => ({ ...(await genuine(h)), ephemeral: offCurve }))).toBe('bad message')
  })

  test('finish is single use, whether the first call failed or succeeded', async () => {
    const m = machine()
    const signer = await device()
    const failedFirst = await startBrowserHandshake({ machineId: m.id, device: signer })
    const reply = (await answerBrowserHandshake({ machineId: m.id, machine: m.signer, hello: failedFirst.hello })).reply
    expect(await rejection(failedFirst.finish({ ...reply, v: 2 }, m.signer.publicKey))).toBe('version')
    expect(await rejection(failedFirst.finish(reply, m.signer.publicKey))).toBe('bad message')

    const browser = await startBrowserHandshake({ machineId: m.id, device: signer })
    const answer = await answerBrowserHandshake({ machineId: m.id, machine: m.signer, hello: browser.hello })
    const [session, again] = await Promise.allSettled([
      browser.finish(answer.reply, m.signer.publicKey),
      browser.finish(answer.reply, m.signer.publicKey),
    ])
    expect(session.status).toBe('fulfilled')
    expect(again.status === 'rejected' && again.reason).toEqual(new E2eError('bad message'))
    expect(await rejection(browser.finish(answer.reply, m.signer.publicKey))).toBe('bad message')
  })

  test('open refuses tampered, replayed and reordered messages, then opens the genuine next one', async () => {
    const { browser, machine: host } = await handshake()
    const aad = encode('aad')
    const m0 = await browser.seal(encode('first'), aad)
    const m1 = await browser.seal(encode('second'), aad)

    const flipped = (index: number) => {
      const copy = new Uint8Array(m0)
      copy[index] = (copy[index] ?? 0) ^ 1
      return copy
    }
    for (const index of [7, 8, m0.length - 17, m0.length - 1]) {
      await rejection(host.open(flipped(index), aad))
    }
    expect(await rejection(host.open(m0.subarray(0, 23), aad))).toBe('bad message')
    expect(await rejection(host.open(m0.subarray(0, m0.length - 1), aad))).toBe('bad message')
    expect(await rejection(host.open(m0, encode('other')))).toBe('bad message')
    expect(await rejection(host.open(m0))).toBe('bad message')
    expect(await rejection(host.open(m1, aad))).toBe('replayed or out of order')

    expect(await host.open(m0, aad)).toEqual(encode('first'))
    expect(await rejection(host.open(m0, aad))).toBe('replayed or out of order')
    expect(await host.open(m1, aad)).toEqual(encode('second'))
  })

  test('seal refuses once the counter is used up, without wrapping', async () => {
    const m = machine()
    const hooks = { maxMessages: 2 }
    const browser = await startBrowserHandshakeWith({ machineId: m.id, device: await device() }, hooks)
    const answer = await answerBrowserHandshakeWith({ machineId: m.id, machine: m.signer, hello: browser.hello }, hooks)
    const session: E2eSession = await browser.finish(answer.reply, m.signer.publicKey)

    await answer.session.open(await session.seal(encode('a')))
    await answer.session.open(await session.seal(encode('b')))
    expect(await rejection(session.seal(encode('c')))).toBe('counter exhausted')
    expect(await rejection(session.seal(encode('d')))).toBe('counter exhausted')
  })
})
