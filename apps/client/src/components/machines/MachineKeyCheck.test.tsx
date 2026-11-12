import { describe, expect, mock, test } from 'bun:test'
import { DEVICE_NOT_APPROVED_CODE, routes } from '@orch/shared'
import type { HostTransport } from '@orch/terminal-ui'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MachineKeyPin } from '../../lib/machineKeys'
import { testMachine } from '../../test/machineKey'
import { memoryMachineKeyStore } from '../../test/machineKeyStore'
import { MachineKeyCheck, type MachineKeyCheckProps } from './MachineKeyCheck'

const machine = testMachine()
const impostor = testMachine()

/** A transport whose machine answers each key request with the next of `answers`, the last one from then on. */
function fakeTransport(...answers: (() => Response)[]) {
  const paths: string[] = []
  const transport: HostTransport = {
    request: async (path) => {
      paths.push(path)
      return (answers.length > 1 ? answers.shift() : answers[0])?.() ?? new Response(null, { status: 500 })
    },
    openSocket: mock(() => {
      throw new Error('no socket may open before the key is checked')
    }),
  }
  return { transport, paths }
}

const serves = (publicKey: string) => () => Response.json({ publicKey })
const unapproved = () => Response.json({ error: 'not approved', code: DEVICE_NOT_APPROVED_CODE }, { status: 403 })

function show(props: Omit<MachineKeyCheckProps, 'children' | 'unapprovedHint' | 'deniedHint'>) {
  return render(
    <MachineKeyCheck {...props} unapprovedHint="Approve ABCD on the machine." deniedHint="Rotate the key." retryMs={5}>
      <p>The machine's page</p>
    </MachineKeyCheck>,
  )
}

const pin = (publicKey: string, source: MachineKeyPin['source']): MachineKeyPin => ({
  publicKey,
  pinnedAt: '2026-11-01T12:00:00.000Z',
  source,
})

/** Waits for the mismatch warning and checks the page stopped there: no Retry, no machine page, no socket. */
async function stopped(transport: HostTransport) {
  expect(await screen.findByRole('alert')).toHaveTextContent("The machine key doesn't match.")
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  expect(screen.queryByText("The machine's page")).not.toBeInTheDocument()
  expect(transport.openSocket).not.toHaveBeenCalled()
}

describe('MachineKeyCheck', () => {
  test('a connect link pins the first key without asking, and a later key that differs stops the page', async () => {
    const { store, pins } = memoryMachineKeyStore()
    const first = fakeTransport(serves(machine.publicKey))
    const view = show({ machineId: machine.id, transport: first.transport, vouchedBy: 'link', store })
    expect(await screen.findByText("The machine's page")).toBeInTheDocument()
    expect(first.paths).toEqual([routes.system.machineKey.path])
    expect(pins.get(machine.id)).toEqual({ publicKey: machine.publicKey, pinnedAt: expect.any(String), source: 'link' })
    view.unmount()

    // Another key under the same id can only be one that doesn't hash to it.
    const later = fakeTransport(serves(impostor.publicKey))
    show({ machineId: machine.id, transport: later.transport, vouchedBy: 'link', store })
    await stopped(later.transport)
    expect(pins.get(machine.id)?.publicKey).toBe(machine.publicKey)
  })

  test('through the account it waits for approval, then pins only once the owner types the matching fingerprint', async () => {
    const user = userEvent.setup()
    const { store, pins } = memoryMachineKeyStore()
    const { transport, paths } = fakeTransport(unapproved, serves(machine.publicKey))
    show({ machineId: machine.id, transport, vouchedBy: 'account', store })
    expect(await screen.findByText('Approve ABCD on the machine.')).toBeInTheDocument()

    expect(await screen.findByText(machine.fingerprint)).toBeInTheDocument()
    expect(paths.length).toBeGreaterThan(1)
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: /fingerprint/ }), impostor.fingerprint)
    expect(confirm).toBeDisabled()
    expect(pins.size).toBe(0)

    await user.clear(screen.getByRole('textbox', { name: /fingerprint/ }))
    await user.type(screen.getByRole('textbox', { name: /fingerprint/ }), machine.fingerprint.toLowerCase())
    await user.click(confirm)
    expect(await screen.findByText("The machine's page")).toBeInTheDocument()
    expect(pins.get(machine.id)).toMatchObject({ publicKey: machine.publicKey, source: 'confirmed' })
    expect(transport.openSocket).not.toHaveBeenCalled()
  })

  test('"It doesn\'t match" pins nothing and stops; a matching pin skips the question; a bad key stops', async () => {
    const user = userEvent.setup()
    const { store, pins } = memoryMachineKeyStore()
    const rejected = fakeTransport(serves(machine.publicKey))
    const view = show({ machineId: machine.id, transport: rejected.transport, vouchedBy: 'account', store })
    await user.click(await screen.findByRole('button', { name: "It doesn't match" }))
    await stopped(rejected.transport)
    expect(pins.size).toBe(0)
    view.unmount()

    pins.set(machine.id, pin(machine.publicKey, 'confirmed'))
    const again = show({
      machineId: machine.id,
      transport: fakeTransport(serves(machine.publicKey)).transport,
      vouchedBy: 'account',
      store,
    })
    expect(await screen.findByText("The machine's page")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    again.unmount()

    for (const served of [serves(impostor.publicKey), serves('not-a-key'), () => Response.json({})]) {
      const bad = fakeTransport(served)
      const page = show({ machineId: machine.id, transport: bad.transport, vouchedBy: 'account', store })
      await stopped(bad.transport)
      page.unmount()
    }
    expect(pins.get(machine.id)?.publicKey).toBe(machine.publicKey)
  })
})
