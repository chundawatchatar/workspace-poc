import { describe, expect, test } from 'bun:test'
import { Toaster } from '@orch/ui'
import { screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { authError, authSession, authUser } from '../../test/betterAuth'
import { server } from '../../test/msw'
import { renderWithProviders } from '../../test/render'
import { AccountMenu } from './AccountMenu'

const account = authUser({ id: 'u1', email: 'u1@example.com', name: 'U' })

/** Renders the menu for a signed-in user, with the app's toaster beside it, and opens it. */
async function openMenu() {
  server.use(
    http.get('*/api/auth/get-session', () =>
      HttpResponse.json({ user: account, session: authSession('s1', account.id) }),
    ),
  )
  const rendered = await renderWithProviders(
    <>
      <AccountMenu />
      <Toaster />
    </>,
    { path: '/settings/account' },
  )
  await rendered.user.click(await screen.findByRole('button', { name: account.email }))
  return rendered
}

describe('AccountMenu', () => {
  test('Sign out signs out and lands on sign-in', async () => {
    let signedOut = 0
    server.use(
      http.post('*/api/auth/sign-out', () => {
        signedOut++
        return HttpResponse.json({ success: true })
      }),
    )
    const { user, router } = await openMenu()
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/auth/sign-in'))
    expect(signedOut).toBe(1)
  })

  test('a failed sign-out shows the error toast at the top right and stays on the page', async () => {
    server.use(http.post('*/api/auth/sign-out', () => authError(500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error')))
    const { user, router } = await openMenu()
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    const toast = await screen.findByRole('alert')
    expect(toast).toHaveTextContent('Signing out failed. Try again.')
    expect(toast).toHaveAttribute('data-placement', 'top-right')
    expect(router.state.location.pathname).toBe('/settings/account')
  })
})
