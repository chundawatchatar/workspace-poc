import { describe, expect, test } from 'bun:test'
import { acceptEmailLinkToken, type EmailLinkWindow, takeEmailLinkToken } from './emailLink'

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

describe('emailed link tokens', () => {
  test('the reset page drops the fragment, keeps path, search and state, and hands the token over once', () => {
    const { win, current, calls, state } = fakeWindow('https://app.test/auth/reset-password?x=1#token=abc')
    acceptEmailLinkToken(win)
    expect(calls).toEqual([{ data: state, url: '/auth/reset-password?x=1' }])
    expect(current.href).toBe('https://app.test/auth/reset-password?x=1')
    expect(takeEmailLinkToken('reset-password')).toBe('abc')
    expect(takeEmailLinkToken('reset-password')).toBeNull()
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0])
  })

  test('other paths, other fragments and connect links are left alone', () => {
    const untouched = [
      'https://app.test/auth/sign-in#token=abc',
      'https://app.test/m/x#token=abc',
      // The removed email verification link is no longer a link page.
      'https://app.test/auth/verify-email#token=t',
      'https://app.test/auth/reset-password#other=1',
      'https://app.test/auth/reset-password',
      'https://app.test/auth/reset-password#machine=m1&key=k1',
    ]
    for (const url of untouched) {
      const { win, current, calls } = fakeWindow(url)
      acceptEmailLinkToken(win)
      expect(calls).toEqual([])
      expect(current.href).toBe(url)
    }
    expect(takeEmailLinkToken('reset-password')).toBeNull()
  })
})
