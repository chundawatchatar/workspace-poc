import { describe, expect, mock, test } from 'bun:test'
import { DEVICE_NOT_APPROVED_CODE, routes } from '@orch/shared'
import type { HostTransport } from '@orch/terminal-ui'
import { screen } from '@testing-library/react'
import type { MachineKeyPin } from '../../lib/machineKeys'
import { testMachine } from '../../test/machineKey'
import { memoryMachineKeyStore } from '../../test/machineKeyStore'
import { renderWithProviders } from '../../test/render'
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

/** Renders the check inside the app's providers, so the mismatch screen can link back home. */
function show(props: Omit<MachineKeyCheckProps, 'children' | 'unapprovedHint' | 'deniedHint'>) {
  return renderWithProviders(
    <MachineKeyCheck
      {...props}
      unapprovedHint="Approve ABCD on the machine."
      deniedHint="Connect it again."
      retryMs={5}
    >
      {() => <p>The machine's page</p>}
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
  expect(screen.getByRole('link', { name: 'Back to your machines' })).toHaveAttribute('href', '/')
  expect(screen.queryByText("The machine's page")).not.toBeInTheDocument()
  expect(transport.openSocket).not.toHaveBeenCalled()
}

describe('MachineKeyCheck', () => {
  test('a pin an older client made from a connect link still opens the page, and a key that differs stops it', async () => {
    const { store, pins } = memoryMachineKeyStore({ [machine.id]: pin(machine.publicKey, 'link') })
    const first = fakeTransport(serves(machine.publicKey))
    const view = await show({ machineId: machine.id, transport: first.transport, store })
    expect(await screen.findByText("The machine's page")).toBeInTheDocument()
    expect(first.paths).toEqual([routes.system.machineKey.path])
    expect(screen.queryByRole('button', { name: 'It matches' })).not.toBeInTheDocument()
    view.unmount()

    // Another key under the same id can only be one that doesn't hash to it.
    const later = fakeTransport(serves(impostor.publicKey))
    await show({ machineId: machine.id, transport: later.transport, store })
    await stopped(later.transport)
    expect(pins.get(machine.id)).toEqual(pin(machine.publicKey, 'link'))
  })

  test('with no pin it waits for approval, then shows the fingerprint and pins once the owner says it matches', async () => {
    const { store, pins } = memoryMachineKeyStore()
    const { transport, paths } = fakeTransport(unapproved, serves(machine.publicKey))
    const { user } = await show({ machineId: machine.id, transport, store })
    expect(await screen.findByText('Approve ABCD on the machine.')).toBeInTheDocument()

    // The fingerprint to compare is shown; nothing is typed, and nothing is pinned until the owner answers.
    expect(await screen.findByText(machine.fingerprint)).toBeInTheDocument()
    expect(paths.length).toBeGreaterThan(1)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(pins.size).toBe(0)

    await user.click(screen.getByRole('button', { name: 'It matches' }))
    expect(await screen.findByText("The machine's page")).toBeInTheDocument()
    expect(pins.get(machine.id)).toEqual({
      publicKey: machine.publicKey,
      pinnedAt: expect.any(String),
      source: 'confirmed',
    })
    expect(transport.openSocket).not.toHaveBeenCalled()
  })

  test('"It doesn\'t match" pins nothing and stops; a matching pin skips the question; a bad key stops', async () => {
    const { store, pins } = memoryMachineKeyStore()
    const rejected = fakeTransport(serves(machine.publicKey))
    const view = await show({ machineId: machine.id, transport: rejected.transport, store })
    await view.user.click(await screen.findByRole('button', { name: "It doesn't match" }))
    await stopped(rejected.transport)
    expect(pins.size).toBe(0)
    view.unmount()

    pins.set(machine.id, pin(machine.publicKey, 'confirmed'))
    const served = fakeTransport(serves(machine.publicKey))
    const again = await show({ machineId: machine.id, transport: served.transport, store })
    expect(await screen.findByText("The machine's page")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'It matches' })).not.toBeInTheDocument()
    again.unmount()

    for (const answer of [serves(impostor.publicKey), serves('not-a-key'), () => Response.json({})]) {
      const bad = fakeTransport(answer)
      const page = await show({ machineId: machine.id, transport: bad.transport, store })
      await stopped(bad.transport)
      page.unmount()
    }
    expect(pins.get(machine.id)?.publicKey).toBe(machine.publicKey)
  })
})
