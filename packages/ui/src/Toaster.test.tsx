import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { act, render, screen } from '@testing-library/react'
import { showToast, TOAST_DURATION } from './lib/toast'
import { Toaster } from './Toaster'

// The toast store is shared by the whole file. A fake clock lets each test run its toast out instead of waiting, so
// none is left for the next test.
beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  act(() => {
    jest.advanceTimersByTime(TOAST_DURATION.error)
  })
  jest.useRealTimers()
})

describe('Toaster', () => {
  test('an info toast is a status at the bottom, and an error toast is an alert where it was asked for', () => {
    render(<Toaster />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    act(() => showToast('Copied the link'))
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Copied the link')
    expect(status).toHaveAttribute('data-placement', 'bottom')

    act(() => showToast('Signing out failed. Try again.', 'error', { placement: 'top-right' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Signing out failed. Try again.')
    expect(alert).toHaveAttribute('data-placement', 'top-right')
  })

  test('a second toast replaces the first', () => {
    render(<Toaster />)

    act(() => showToast('Copied the link'))
    act(() => showToast('Copied the path'))
    expect(screen.getByRole('status')).toHaveTextContent('Copied the path')
    expect(screen.queryByText('Copied the link')).not.toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})
