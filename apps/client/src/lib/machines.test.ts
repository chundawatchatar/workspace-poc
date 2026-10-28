import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { formatConnectFragment } from '@orch/shared'
import { acceptConnectLink, type ConnectWindow, forgetMachine, loadMachines } from './machines'
import { installMemoryStorage, uninstallMemoryStorage } from './testStorage'

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

beforeEach(() => installMemoryStorage())
afterAll(() => uninstallMemoryStorage())

describe('connect links', () => {
  test('a valid fragment saves the machine, replaces one with the same id, and leaves the URL', () => {
    const first = fakeWindow(
      `https://app.test/anything${formatConnectFragment({ machineId: 'abcdef123456', key: 'k1' })}`,
    )
    expect(acceptConnectLink(first.win)).toBe('abcdef123456')
    expect(first.current.href).toBe('https://app.test/m/abcdef123456')
    expect(first.current.href).not.toContain('#')
    expect(loadMachines()).toEqual([{ id: 'abcdef123456', name: 'Machine abcdef12', key: 'k1' }])

    const again = fakeWindow(`https://app.test/${formatConnectFragment({ machineId: 'abcdef123456', key: 'k2' })}`)
    acceptConnectLink(again.win)
    expect(loadMachines()).toEqual([{ id: 'abcdef123456', name: 'Machine abcdef12', key: 'k2' }])
  })

  test('a fragment with a missing or empty field is not saved, but any key in it leaves the URL', () => {
    const cases = { '#machine=m1': '#machine=m1', '#other=1': '#other=1', '': '' }
    for (const [hash, after] of Object.entries(cases)) {
      const { win, current } = fakeWindow(`https://app.test/page?q=1${hash}`)
      expect(acceptConnectLink(win)).toBeNull()
      expect(current.hash).toBe(after)
    }
    for (const hash of ['#key=k1', '#machine=&key=k1', '#machine=m1&key=']) {
      const { win, current } = fakeWindow(`https://app.test/page?q=1${hash}`)
      expect(acceptConnectLink(win)).toBeNull()
      expect(current.href).toBe('https://app.test/page?q=1')
    }
    expect(loadMachines()).toEqual([])
  })

  test('forget removes the machine and its key', () => {
    acceptConnectLink(fakeWindow('https://app.test/#machine=m1&key=k1').win)
    acceptConnectLink(fakeWindow('https://app.test/#machine=m2&key=k2').win)
    forgetMachine('m1')
    expect(loadMachines().map((m) => m.id)).toEqual(['m2'])
    expect(localStorage.getItem('orch-machines')).not.toContain('k1')
  })
})
