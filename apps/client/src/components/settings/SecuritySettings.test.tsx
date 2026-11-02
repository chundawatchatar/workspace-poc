import { describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { authError, authSession, authUser } from '../../test/betterAuth'
import { server } from '../../test/msw'
import { renderWithProviders } from '../../test/render'
import { SecuritySettings } from './SecuritySettings'

const account = authUser({ id: 'u1', email: 'u1@example.com', name: 'U' })
const session = authSession('s1', account.id)

/** Answers the signed-in session and its list, which the page reads as it opens. */
function signedIn() {
  server.use(
    http.get('*/api/auth/get-session', () => HttpResponse.json({ user: account, session })),
    http.get('*/api/auth/list-sessions', () => HttpResponse.json([session])),
  )
}

async function setup() {
  signedIn()
  const rendered = await renderWithProviders(<SecuritySettings />, { path: '/settings/security' })
  await screen.findByRole('columnheader', { name: 'Last active' })
  return rendered
}

describe('SecuritySettings', () => {
  test('Change password opens the form and Cancel closes it', async () => {
    const { user } = await setup()

    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(screen.getByLabelText('Current password')).toBeInTheDocument()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toHaveAttribute('aria-expanded', 'true')

    await user.click(cancel)
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toHaveAttribute('aria-expanded', 'false')
  })

  test('a wrong current password shows the error, and the right one changes it and ends the other sessions', async () => {
    const sent: unknown[] = []
    server.use(
      http.post('*/api/auth/change-password', async ({ request }) => {
        const body = (await request.json()) as { currentPassword: string }
        sent.push(body)
        if (body.currentPassword !== 'pw-old') return authError(400, 'INVALID_PASSWORD', 'Invalid password')
        return HttpResponse.json({ token: 't2', user: account })
      }),
    )
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    // The toggle now reads Cancel, so the form's submit button is the one left with this name.
    const submit = () => screen.getByRole('button', { name: 'Change password' })
    await user.type(screen.getByLabelText('Current password'), 'pw-wrong')
    await user.type(screen.getByLabelText('New password'), 'pw-new-long')
    await user.type(screen.getByLabelText('Confirm new password'), 'pw-new-long')
    await user.click(submit())

    expect(await screen.findByRole('alert')).toHaveTextContent('Your current password is wrong.')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()

    await user.clear(screen.getByLabelText('Current password'))
    await user.type(screen.getByLabelText('Current password'), 'pw-old')
    await user.click(submit())

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Your password has changed'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sent).toEqual([
      { currentPassword: 'pw-wrong', newPassword: 'pw-new-long', revokeOtherSessions: true },
      { currentPassword: 'pw-old', newPassword: 'pw-new-long', revokeOtherSessions: true },
    ])
  })

  test('signing out from all devices asks first: Cancel sends nothing, Confirm ends them and goes to sign-in', async () => {
    const { user, router } = await setup()

    await user.click(screen.getByRole('button', { name: 'Sign out from all devices' }))
    expect(screen.getByText('Sign out on every device, this one included?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    // No `revoke-sessions` handler yet, so a request here would fail the test.
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Sign out from all devices' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings/security')

    let revoked = 0
    server.use(
      http.post('*/api/auth/revoke-sessions', () => {
        revoked++
        return HttpResponse.json({ status: true })
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Sign out from all devices' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/auth/sign-in'))
    expect(revoked).toBe(1)
  })
})
