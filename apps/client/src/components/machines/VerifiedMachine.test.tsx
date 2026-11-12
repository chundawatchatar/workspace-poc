import { describe, expect, test } from 'bun:test'
import type { HostTransport } from '@orch/terminal-ui'
import { act, screen } from '@testing-library/react'
import { testMachine } from '../../test/machineKey'
import { memoryMachineKeyStore } from '../../test/machineKeyStore'
import { renderWithProviders } from '../../test/render'
import { MachineKeyCheck } from './MachineKeyCheck'
import { VerifiedMachine, type VerifiedTransportOptions } from './VerifiedMachine'

const machine = testMachine()

/** A transport whose machine answers its key. */
const keyTransport: HostTransport = {
  request: async () => Response.json({ publicKey: machine.publicKey }),
  openSocket: () => {
    throw new Error('the key check opens no socket')
  },
}

describe('VerifiedMachine', () => {
  test('the page gets a transport bound to the pinned key, and an unverified machine swaps it for the warning', async () => {
    const { store } = memoryMachineKeyStore()
    const built: VerifiedTransportOptions[] = []
    const pageTransport = { ...keyTransport }
    const given: HostTransport[] = []
    const createTransport = (options: VerifiedTransportOptions) => {
      built.push(options)
      return pageTransport
    }
    await renderWithProviders(
      <MachineKeyCheck
        machineId={machine.id}
        transport={keyTransport}
        vouchedBy="link"
        unapprovedHint="Approve it."
        deniedHint="Rotate the key."
        store={store}
      >
        {(publicKey) => (
          <VerifiedMachine publicKey={publicKey} createTransport={createTransport}>
            {(transport) => {
              given.push(transport)
              return <p>The machine's page</p>
            }}
          </VerifiedMachine>
        )}
      </MachineKeyCheck>,
    )
    expect(await screen.findByText("The machine's page")).toBeInTheDocument()
    expect(built.map((options) => options.machinePublicKey)).toEqual([machine.publicKey])
    expect(given.at(-1)).toBe(pageTransport)

    act(() => built[0]?.onMachineUnverified())
    expect(await screen.findByRole('alert')).toHaveTextContent("The machine key doesn't match.")
    expect(screen.queryByText("The machine's page")).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })
})
