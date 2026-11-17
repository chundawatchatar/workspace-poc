import { describe, expect, test } from 'bun:test'
import { formatConnectFragment } from '@orch/shared'
import { testMachine } from '../test/machineKey'
import { clearSavedMachineKeys, type SavedKeysWindow } from './machines'

const machine = testMachine()
const connectLink = formatConnectFragment({ machineId: machine.id, key: 'k1', fingerprint: machine.fingerprint })

/** A window at `url` over this page's storage, whose `replaceState` moves it like a browser's would. */
function fakeWindow(url: string) {
  const current = new URL(url)
  const replaced: unknown[] = []
  const win: SavedKeysWindow = {
    localStorage,
    location: current,
    history: {
      state: { key: 'router-entry' },
      replaceState: (data, _unused, next) => {
        replaced.push(data)
        if (next) current.href = new URL(next, current).href
      },
    },
  }
  return { win, current, replaced }
}

describe('clearSavedMachineKeys', () => {
  test('removes the saved keys and leaves every other entry as it was', () => {
    localStorage.setItem('orch-machines', JSON.stringify([{ id: machine.id, name: 'Laptop', key: 'k1' }]))
    localStorage.setItem('orch-theme', 'dark')
    const { win, current, replaced } = fakeWindow('https://app.test/page?q=1')
    clearSavedMachineKeys(win)
    expect(Object.fromEntries(Object.entries(localStorage))).toEqual({ 'orch-theme': 'dark' })
    expect(current.href).toBe('https://app.test/page?q=1')
    expect(replaced).toEqual([])
    // Nothing saved is fine too.
    clearSavedMachineKeys(win)
    expect(Object.fromEntries(Object.entries(localStorage))).toEqual({ 'orch-theme': 'dark' })
  })

  test("an old connect link's key leaves the URL, keeping the path, search and router state; other fragments stay", () => {
    for (const hash of [connectLink, '#key=k1', '#machine=m1&key=']) {
      const { win, current, replaced } = fakeWindow(`https://app.test/anything?q=1${hash}`)
      clearSavedMachineKeys(win)
      expect(current.href).toBe('https://app.test/anything?q=1')
      expect(replaced).toEqual([{ key: 'router-entry' }])
    }
    for (const hash of ['#token=t1', '#machine=m1', '']) {
      const { win, current, replaced } = fakeWindow(`https://app.test/auth/verify-email${hash}`)
      clearSavedMachineKeys(win)
      expect(current.hash).toBe(hash)
      expect(replaced).toEqual([])
    }
    expect(localStorage.length).toBe(0)
  })

  test('storage the browser refuses is skipped, and the key still leaves the URL', () => {
    const { win, current } = fakeWindow(`https://app.test/anything${connectLink}`)
    // A browser that blocks storage for the site throws on reading `localStorage` at all.
    Object.defineProperty(win, 'localStorage', {
      get: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    expect(() => clearSavedMachineKeys(win)).not.toThrow()
    expect(current.href).toBe('https://app.test/anything')
  })
})
