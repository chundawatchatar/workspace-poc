import { afterAll, describe, expect, test } from 'bun:test'
import { acceptEmailLinkToken, type EmailLinkWindow, takeEmailLinkToken } from './emailLink'
import { installMemoryStorage, uninstallMemoryStorage } from './testStorage'

/** A window at `url` that records each `replaceState` and moves like a browser's would. */
function fakeWindow(url: string) {
  const current = new URL(url)
  const calls: { data: unknown; url?: string }[] = []
  const state = { key: 'router-entry' }
  const win: EmailLinkWindow = {
    location: current,
    history: {
      state,
      replaceState: (data, _unused, next) => {
        calls.push({ data, url: next })
        if (next) current.href = new URL(next, current).href
      },
    },
  }
  return { win, current, calls, state }
}

afterAll(() => {
  uninstallMemoryStorage()
  uninstallMemoryStorage('sessionStorage')
})

describe('emailed link tokens', () => {
  test('a link page drops the fragment, keeps path, search and state, and hands the token to that page once', () => {
    const stores = [installMemoryStorage(), installMemoryStorage('sessionStorage')]
    for (const page of ['verify-email', 'reset-password'] as const) {
      const { win, current, calls, state } = fakeWindow(`https://app.test/auth/${page}?x=1#token=abc`)
      acceptEmailLinkToken(win)
      expect(calls).toEqual([{ data: state, url: `/auth/${page}?x=1` }])
      expect(current.href).toBe(`https://app.test/auth/${page}?x=1`)

      const other = page === 'verify-email' ? 'reset-password' : 'verify-email'
      expect(takeEmailLinkToken(other)).toBeNull()
      expect(takeEmailLinkToken(page)).toBe('abc')
      expect(takeEmailLinkToken(page)).toBeNull()
    }
    expect(stores.map((store) => store.length)).toEqual([0, 0])
  })

  test('other paths, other fragments and connect links are left alone', () => {
    const untouched = [
      'https://app.test/auth/sign-in#token=abc',
      'https://app.test/m/x#token=abc',
      'https://app.test/auth/verify-email#other=1',
      'https://app.test/auth/verify-email',
      'https://app.test/auth/verify-email#machine=m1&key=k1',
    ]
    for (const url of untouched) {
      const { win, current, calls } = fakeWindow(url)
      acceptEmailLinkToken(win)
      expect(calls).toEqual([])
      expect(current.href).toBe(url)
    }
    expect(takeEmailLinkToken('verify-email')).toBeNull()
    expect(takeEmailLinkToken('reset-password')).toBeNull()
  })
})
