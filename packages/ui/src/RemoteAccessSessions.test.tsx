import { describe, expect, mock, test } from 'bun:test'
import { formatLocalDateTime, type SessionsResponse } from '@orch/shared'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RemoteAccessSessions } from './RemoteAccessSessions'

const startedAt = '2026-11-06T12:00:00.000Z'
const sessions: SessionsResponse = {
  sessions: [
    {
      deviceId: `a${'d'.repeat(42)}`,
      fingerprint: 'ABCD-EFGH',
      credentials: [{ kind: 'account' }],
      sockets: 3,
      startedAt,
    },
    {
      deviceId: `b${'d'.repeat(42)}`,
      fingerprint: 'JKMN-PQRS',
      credentials: [{ kind: 'account' }],
      sockets: 1,
      startedAt,
    },
  ],
}

describe('RemoteAccessSessions', () => {
  test('lists each session with its credentials, sockets and start, and End sends its device id', async () => {
    const user = userEvent.setup()
    const onEnd = mock()
    render(<RemoteAccessSessions sessions={sessions} onEnd={onEnd} busy={false} />)

    const [first, second] = within(screen.getByRole('list', { name: 'Open sessions' })).getAllByRole('listitem')
    expect(first).toHaveTextContent(`ABCD-EFGHAccount · 3 sockets · since ${formatLocalDateTime(startedAt)}`)
    expect(second).toHaveTextContent('Account · 1 socket')
    expect(screen.getByText(/stays approved/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'End JKMN-PQRS' }))
    expect(onEnd).toHaveBeenCalledWith(`b${'d'.repeat(42)}`)
  })

  test('the End buttons wait while busy, and no session shows an empty line', () => {
    const { rerender } = render(<RemoteAccessSessions sessions={sessions} onEnd={mock()} busy />)
    expect(screen.getByRole('button', { name: 'End ABCD-EFGH' })).toBeDisabled()

    rerender(<RemoteAccessSessions sessions={{ sessions: [] }} onEnd={mock()} busy={false} />)
    expect(screen.queryByRole('button', { name: /^End / })).not.toBeInTheDocument()
    expect(screen.getByText('No browser is connected through the tunnel.')).toBeInTheDocument()
  })
})
