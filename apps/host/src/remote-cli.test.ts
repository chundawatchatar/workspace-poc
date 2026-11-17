import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { machineFingerprint } from '@orch/shared'
import { accessKeysPath } from './modules/access/access.repository'
import { DevicesRepository, devicesPath } from './modules/remote-access/devices.repository'
import { DEFAULT_SERVER_URL } from './modules/remote-access/remote-access.service'
import { machineKeyFile } from './modules/tunnel/tunnel.repository'
import {
  alice,
  bob,
  carol,
  dir,
  host,
  linked,
  MINUTE,
  machineKey,
  run,
  runningHost,
  stoppedHost,
  useRemoteCliHarness,
} from './remote-cli.testing'

useRemoteCliHarness()

describe('host:remote with the host running', () => {
  test('status prints the address, the connection, the machine and the account', async () => {
    const url = runningHost()
    host.current = { ...host.current, tunnel: 'connected', linkedAccount: linked }

    const status = await run(url, ['status'])
    expect(status.code).toBe(0)
    expect(status.text).toContain(`Server address: ${DEFAULT_SERVER_URL} (default)`)
    expect(status.text).toContain('Connection:     connected, tunnel connected')
    expect(status.text).toContain(`Machine id:     ${machineKey.machineId}`)
    expect(status.text).toContain(`Machine key:    ${machineFingerprint(machineKey.machineId)}\n`)
    expect(status.text).toContain(`Account:        Ada (a***@example.com) through ${DEFAULT_SERVER_URL}`)
  })

  test('devices lists waiting then approved devices with their ages, and status counts them', async () => {
    const url = runningHost()
    expect((await run(url, ['devices'])).text).toContain('No devices are approved or waiting')
    expect((await run(url, ['status'])).text).toContain('Devices:        0 approved, 0 waiting')

    host.devices.recordPending(alice.id, alice.publicKey)
    host.devices.approve(alice.fingerprint)
    host.clock += 2 * 24 * 60 * MINUTE
    host.devices.recordPending(bob.id, bob.publicKey)
    host.clock += MINUTE
    host.devices.recordPending(carol.id, carol.publicKey)
    host.clock += 3 * MINUTE

    const list = await run(url, ['devices'])
    expect(list.code).toBe(0)
    expect(list.text.split('\n')).toEqual([
      `${carol.fingerprint}  waiting, seen 3 min ago`,
      `${bob.fingerprint}  waiting, seen 4 min ago`,
      `${alice.fingerprint}  approved 2 days ago`,
    ])
    const status = await run(url, ['status'])
    expect(status.code).toBe(0)
    expect(status.text).toContain('Devices:        1 approved, 2 waiting')
  })

  test('devices approve asks, and approves the matching device only on yes', async () => {
    const url = runningHost()
    host.devices.recordPending(alice.id, alice.publicKey)
    const typed = alice.fingerprint.replaceAll('-', '').toLowerCase()

    for (const answer of ['', 'n', null]) {
      const no = await run(url, ['devices', 'approve', typed], { answers: [answer] })
      expect(no.code).toBe(1)
      expect(no.text).toContain('Approve only a fingerprint shown in your own browser.')
      expect(no.text).toContain(`Approve ${typed}? It will be able to open this machine remotely. [y/N]`)
      // No answer at all, as when stdin isn't a terminal, says how to approve instead of a bare refusal.
      expect(no.text).toContain(answer === null ? 'No answer could be read, so nothing was approved' : 'Not approved')
    }
    expect(host.calls).toEqual([])

    const yes = await run(url, ['devices', 'approve', typed], { answers: ['Yes'] })
    expect(yes.code).toBe(0)
    expect(yes.text).toContain(`Approved ${alice.fingerprint}`)
    expect(host.calls).toEqual([['approveDevice', typed]])

    const again = await run(url, ['devices', 'approve', alice.fingerprint])
    expect(again.code).toBe(0)
    expect(again.text).toContain(`${alice.fingerprint} is already approved`)
    expect(again.text).not.toContain('[y/N]')
    expect(host.calls).toHaveLength(1)
  })

  test('devices approve --yes skips the question, and a fingerprint the host matches to no device or two exits 1', async () => {
    const url = runningHost()
    host.devices.recordPending(alice.id, alice.publicKey)
    host.devices.recordPending(bob.id, bob.publicKey)
    const yes = await run(url, ['devices', 'approve', '--yes', alice.fingerprint])
    expect(yes.code).toBe(0)
    expect(yes.text).not.toContain('[y/N]')
    expect((await run(url, ['devices', 'approve', bob.fingerprint, '--yes'])).code).toBe(0)
    expect(host.calls).toEqual([
      ['approveDevice', alice.fingerprint],
      ['approveDevice', bob.fingerprint],
    ])

    const notWaiting = (typed: string) =>
      `No browser with the fingerprint ${typed} is waiting. Open this machine in your own browser and type the fingerprint it shows.`
    for (const typed of [carol.fingerprint, 'nope']) {
      const unknown = await run(url, ['devices', 'approve', typed, '--yes'])
      expect(unknown.code).toBe(1)
      expect(unknown.text).toBe(notWaiting(typed))
    }
    host.devices.recordPending(carol.id, carol.publicKey)
    const expired = await run(url, ['devices', 'approve', carol.fingerprint], {
      answers: ['y'],
      onPrompt: () => host.devices.remove(carol.id),
    })
    expect(expired.code).toBe(1)
    expect(expired.text).toContain(notWaiting(carol.fingerprint))

    // Two waiting devices with one fingerprint (the id's last character is past it): the host approves neither.
    for (const last of ['A', 'B']) host.devices.recordPending(`${carol.id.slice(0, -1)}${last}`, carol.publicKey)
    const several = await run(url, ['devices', 'approve', carol.fingerprint, '--yes'])
    expect(several.code).toBe(1)
    expect(several.text).toContain('More than one browser has the fingerprint')
    expect(host.devices.list().approved.map((d) => d.id)).toEqual([bob.id, alice.id])
  })

  test('devices remove dismisses a waiting device or revokes an approved one', async () => {
    const url = runningHost()
    host.devices.recordPending(alice.id, alice.publicKey)
    host.devices.approve(alice.fingerprint)
    host.devices.recordPending(bob.id, bob.publicKey)

    expect((await run(url, ['devices', 'remove', bob.fingerprint])).text).toContain(`Dismissed ${bob.fingerprint}`)
    const revoked = await run(url, ['devices', 'remove', alice.fingerprint])
    expect(revoked.code).toBe(0)
    expect(revoked.text).toContain(`Revoked ${alice.fingerprint}. The sockets it had open are closed.`)
    expect(host.calls).toEqual([
      ['removeDevice', bob.id],
      ['removeDevice', alice.id],
    ])

    expect((await run(url, ['devices', 'remove', alice.fingerprint])).code).toBe(1)
    expect(host.calls).toHaveLength(2)
  })
})

describe('host:remote with the host stopped', () => {
  test('status reads the files without creating a machine key or access keys', async () => {
    const url = stoppedHost()
    const empty = await run(url, ['status'], { env: { SERVER_URL: 'ws://127.0.0.1:4600' } })
    expect(empty.code).toBe(0)
    expect(empty.text).toContain('ws://127.0.0.1:4600 (from SERVER_URL)')
    expect(empty.text).toContain('Connection:     not connected, tunnel host not running')
    expect(empty.text).toContain('Machine id:     none yet')
    expect(empty.text).toContain('Machine key:    none yet')
    expect(empty.text).toContain('Account:        not connected')
    expect(existsSync(machineKeyFile(dir))).toBe(false)
    expect(existsSync(accessKeysPath(dir))).toBe(false)

    writeFileSync(join(dir, 'machine-key'), machineKey.pem)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ relayUrl: 'wss://host' }))
    writeFileSync(join(dir, 'linked-account.json'), JSON.stringify(linked))
    const saved = await run(url, ['status'])
    expect(saved.text).toContain('Server address: wss://host\n')
    expect(saved.text).toContain('Connection:     connected, tunnel host not running')
    expect(saved.text).toContain(machineKey.machineId)
    expect(saved.text).toContain(`Machine key:    ${machineFingerprint(machineKey.machineId)}\n`)
    expect(saved.text).toContain('Ada (a***@example.com)')

    writeFileSync(join(dir, 'linked-account.json'), 'not json')
    const broken = await run(url, ['status'])
    expect(broken.code).toBe(1)
    expect(broken.text).toContain('Connection:     unknown')
  })

  test('devices lists and removes the approved devices in the file, and approve needs the host', async () => {
    const url = stoppedHost()
    const file = devicesPath(dir)
    const missing = await run(url, ['devices'])
    expect(missing.code).toBe(0)
    expect(missing.text).toContain('No devices are approved')
    expect((await run(url, ['devices', 'remove', alice.fingerprint])).code).toBe(1)
    expect(existsSync(file)).toBe(false)

    const approvedAt = (ms: number) => new Date(host.clock - ms).toISOString()
    new DevicesRepository(file).save([
      { id: alice.id, publicKey: alice.publicKey, approvedAt: approvedAt(3 * 24 * 60 * MINUTE) },
      { id: bob.id, publicKey: bob.publicKey, approvedAt: approvedAt(2 * 60 * MINUTE) },
    ])
    const list = await run(url, ['devices'])
    expect(list.text).toContain(`${bob.fingerprint}  approved 2 hours ago\n${alice.fingerprint}  approved 3 days ago`)
    expect(list.text).toContain('known only to the running host')
    expect((await run(url, ['status'])).text).toContain(
      'Devices:        2 approved, waiting unknown (host not running)',
    )

    const approve = await run(url, ['devices', 'approve', carol.fingerprint, '--yes'])
    expect(approve.code).toBe(1)
    expect(approve.text).toContain('Start the host, then run this again')

    const remove = await run(url, ['devices', 'remove', alice.fingerprint.toLowerCase()])
    expect(remove.code).toBe(0)
    expect(remove.text).toContain(`Revoked ${alice.fingerprint}`)
    expect(new DevicesRepository(file).load().map((saved) => saved.id)).toEqual([bob.id])
    expect((await run(url, ['devices', 'remove', carol.fingerprint])).code).toBe(1)
  })

  test('a devices file that is not valid is reported and never rewritten', async () => {
    const url = stoppedHost()
    writeFileSync(devicesPath(dir), '{ broken')
    for (const args of [['devices'], ['devices', 'remove', alice.fingerprint], ['status']]) {
      const { code, text } = await run(url, args)
      expect(code).toBe(1)
      expect(text).toContain('are not valid')
    }
    expect(readFileSync(devicesPath(dir), 'utf8')).toBe('{ broken')
  })

  test('a missing or unknown command prints the usage', async () => {
    const url = stoppedHost()
    const wrong = [[], ['nope'], ['link'], ['connect'], ['disconnect', 'now'], ['devices', 'approve']]
    for (const args of [...wrong, ['devices', 'remove', 'A', '--yes']]) {
      const { code, text } = await run(url, args)
      expect(code).toBe(1)
      for (const command of [
        'status',
        'connect --email <email> --key <key> [--server <url>] [--yes]',
        'disconnect [--yes]',
        'devices approve <fingerprint> [--yes]',
        'devices remove <fingerprint>',
      ])
        expect(text).toContain(command)
      for (const gone of ['link <key>', 'unlink', '  server <url>', '  on ', '  off ']) expect(text).not.toContain(gone)
    }
  })
})
