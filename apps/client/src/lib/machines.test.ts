import { describe, expect, test } from 'bun:test'
import { formatConnectFragment } from '@orch/shared'
import { testMachine } from '../test/machineKey'
import { acceptConnectLink, type ConnectWindow, forgetMachine, loadMachines } from './machines'

/** A window at `url`, whose `replaceState` moves it like a browser's would. */
function fakeWindow(url: string) {
  const current = new URL(url)
  const win: ConnectWindow = {
    location: current,
    history: {
      state: null,
      replaceState: (_data, _unused, next) => {
        if (next) current.href = new URL(next, current).href
      },
    },
  }
  return { win, current }
}

const [one, two] = [testMachine(), testMachine()]
const link = (machine: typeof one, key: string, fingerprint = machine.fingerprint) =>
  `https://app.test/anything${formatConnectFragment({ machineId: machine.id, key, fingerprint })}`

describe('connect links', () => {
  test('a link whose fp matches its id saves the machine, writes nothing else to storage, and leaves the URL', () => {
    const first = fakeWindow(link(one, 'k1'))
    expect(acceptConnectLink(first.win)).toBe(one.id)
    expect(first.current.href).toBe(`https://app.test/m/${one.id}`)
    const saved = { id: one.id, name: `Machine ${one.id.slice(0, 8)}`, fingerprint: one.fingerprint }
    expect(loadMachines()).toEqual([{ ...saved, key: 'k1' }])
    // Only the machine's own entry: nothing is recorded for the account, and no machine key.
    expect(Object.keys(localStorage)).toEqual(['orch-machines'])

    // The fingerprint is compared as typed fingerprints are: case and dashes don't matter.
    acceptConnectLink(fakeWindow(link(one, 'k2', one.fingerprint.toLowerCase().replaceAll('-', ''))).win)
    expect(loadMachines()).toEqual([{ ...saved, key: 'k2' }])
  })

  test("a link with a missing field, or an fp that isn't its id's, is not saved, but its key leaves the URL", () => {
    const cases = { '#machine=m1': '#machine=m1', '#other=1': '#other=1', '': '' }
    for (const [hash, after] of Object.entries(cases)) {
      const { win, current } = fakeWindow(`https://app.test/page?q=1${hash}`)
      expect(acceptConnectLink(win)).toBeNull()
      expect(current.hash).toBe(after)
    }
    const refused = [
      '#key=k1',
      '#machine=&key=k1&fp=x',
      `#machine=${one.id}&key=`,
      `#machine=${one.id}&key=k1`,
      `#machine=${one.id}&key=k1&fp=${two.fingerprint}`,
      `#machine=short&key=k1&fp=${one.fingerprint}`,
    ]
    for (const hash of refused) {
      const { win, current } = fakeWindow(`https://app.test/page?q=1${hash}`)
      expect(acceptConnectLink(win)).toBeNull()
      expect(current.href).toBe('https://app.test/page?q=1')
    }
    expect(loadMachines()).toEqual([])
  })

  test('forget removes the machine and its key', () => {
    acceptConnectLink(fakeWindow(link(one, 'k1')).win)
    acceptConnectLink(fakeWindow(link(two, 'k2')).win)
    forgetMachine(one.id)
    expect(loadMachines().map((m) => m.id)).toEqual([two.id])
    expect(localStorage.getItem('orch-machines')).not.toContain('k1')
  })
})
