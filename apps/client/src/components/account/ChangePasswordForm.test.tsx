import { describe, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '../../test/render'
import { ChangePasswordForm } from './ChangePasswordForm'

describe('ChangePasswordForm', () => {
  test('one empty status region is mounted before any submit, ready to announce the change', async () => {
    await renderWithProviders(<ChangePasswordForm />)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })
})
