import { describe, expect, test } from 'bun:test'
import { formatLocalDateTime } from '@orch/shared'
import { render, screen } from '@testing-library/react'
import { RemoteAccessActivity } from './RemoteAccessActivity'

describe('RemoteAccessActivity', () => {
  test('labels a refusal for unsealed traffic with its time, and no fingerprint', () => {
    const at = '2026-11-13T09:30:00.000Z'
    render(<RemoteAccessActivity entries={[{ kind: 'refused', reason: 'unsealed', at }]} failed={false} />)

    const [row] = screen.getAllByRole('listitem')
    expect(row).toHaveTextContent(`Refused: not end-to-end encrypted${formatLocalDateTime(at)}`)
  })
})
