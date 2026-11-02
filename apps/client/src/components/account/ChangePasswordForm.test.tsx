import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChangePasswordForm } from './ChangePasswordForm'

describe('ChangePasswordForm', () => {
  test('one empty status region is mounted before any submit, ready to announce the change', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ChangePasswordForm />
      </QueryClientProvider>,
    )
    expect(html.match(/role="status"/g)).toHaveLength(1)
    expect(html).toMatch(/<p role="status"[^>]*><\/p>/)
  })
})
