import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { type SessionRow, sessionsQuery } from '../lib/accountSessions'
import { SessionsTable } from './SessionsTable'

const rows: SessionRow[] = [
  {
    id: 's1',
    device: 'Firefox on macOS',
    ipAddress: '127.0.0.1',
    createdAt: '2026-10-01T10:00:00.000Z',
    lastActiveAt: '2026-10-29T10:00:00.000Z',
    current: true,
  },
]

describe('SessionsTable', () => {
  test('the "Last active" header is described by a visible note saying it is approximate, not by a title', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(sessionsQuery('u1').queryKey, rows)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SessionsTable userId="u1" />
      </QueryClientProvider>,
    )
    const header = html.match(/<th\b([^>]*)>Last active<\/th>/)
    expect(header).toBeTruthy()
    expect(header?.[1]).not.toContain('title=')
    const describedBy = header?.[1].match(/aria-describedby="([^"]+)"/)?.[1]
    expect(describedBy).toBeTruthy()
    const note = html.match(new RegExp(`<p id="${describedBy}"[^>]*>([^<]*)</p>`))?.[1]
    expect(note).toContain('approximate')
    expect(note).toContain('renewed')
    expect(html).not.toContain('title=')
  })
})
