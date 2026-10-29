import { useSyncExternalStore } from 'react'

// The token an emailed link carries in its fragment (`/auth/verify-email#token=…`, `/auth/reset-password#token=…`).
// It is read before the router starts and removed from the address bar, so it never enters the router's history, a
// query key or storage. It lives only in this module until its page takes it; a reload finds none.

/** The pages an emailed link opens. */
export type EmailLinkPage = 'verify-email' | 'reset-password'

/** The parts of `window` that `acceptEmailLinkToken` uses. */
export interface EmailLinkWindow {
  location: { hash: string; pathname: string; search: string }
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string): void }
}

const PAGES: Record<string, EmailLinkPage> = {
  '/auth/verify-email': 'verify-email',
  '/auth/reset-password': 'reset-password',
}

let kept: { page: EmailLinkPage; token: string } | null = null
let arrivals = 0
const listeners = new Set<() => void>()

/**
 * Keeps the token from an emailed link's fragment when the URL is one of the link pages, and replaces the URL with
 * the same path and search, without the fragment. Any other URL is left alone.
 */
export function acceptEmailLinkToken(win: EmailLinkWindow = window): void {
  // The router reaches the same page with a trailing slash.
  const page = PAGES[win.location.pathname.replace(/(.)\/+$/, '$1')]
  if (!page) return
  const fragment = new URLSearchParams(win.location.hash.slice(1))
  if (!fragment.has('token')) return
  const token = fragment.get('token')
  kept = token ? { page, token } : null
  // Keep the router's state for this entry; only the URL changes.
  win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`)
  if (!kept) return
  arrivals++
  for (const listener of listeners) listener()
}

let listening = false

/**
 * Also reads the token of a link opened in a tab already on its page, which changes only the fragment. Call it before
 * the router starts, so this `popstate` listener runs before the router's own. It adds the listener once, however
 * often it is called.
 */
export function listenForEmailLinks() {
  if (listening) return
  listening = true
  window.addEventListener('popstate', () => acceptEmailLinkToken())
}

/** The token kept for `page`, handed out once; null when there is none, or it was already taken. */
export function takeEmailLinkToken(page: EmailLinkPage): string | null {
  if (kept?.page !== page) return null
  const { token } = kept
  kept = null
  return token
}

/**
 * How many tokens have arrived so far. A link page keys itself on it, so a link opened in a tab already on that page,
 * which changes only the fragment, starts the page afresh with the new token.
 */
export function useEmailLinkArrivals(): number {
  return useSyncExternalStore(subscribe, readArrivals, readArrivals)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function readArrivals() {
  return arrivals
}
