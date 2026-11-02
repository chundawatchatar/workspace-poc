import { describe, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { authSession, authUser } from '../../test/betterAuth'
import { server } from '../../test/msw'
import { renderWithProviders } from '../../test/render'
import { SessionsTable } from './SessionsTable'

const user = authUser({ id: 'u1', email: 'u1@example.com', name: 'U' })

describe('SessionsTable', () => {
  test('the "Last active" header is described by a note saying it is approximate, not by a title', async () => {
    const session = authSession('s1', user.id)
    server.use(
      http.get('*/api/auth/get-session', () => HttpResponse.json({ user, session })),
      http.get('*/api/auth/list-sessions', () => HttpResponse.json([session])),
    )
    await renderWithProviders(<SessionsTable userId={user.id} />)
    const header = await screen.findByRole('columnheader', { name: 'Last active' })
    expect(header).toHaveAccessibleDescription(/approximate/)
    expect(header).toHaveAccessibleDescription(/renewed/)
    expect(header).not.toHaveAttribute('title')
  })
})
