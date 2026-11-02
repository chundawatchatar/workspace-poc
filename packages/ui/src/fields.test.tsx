import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Button } from './Button'
import { FormError } from './FormError'
import { PasswordField } from './PasswordField'
import { TextField } from './TextField'

const noop = () => {}

describe('TextField and PasswordField', () => {
  test('the label names the field, and an error marks it invalid and describes it with the hint', () => {
    for (const Field of [TextField, PasswordField]) {
      const { rerender, unmount } = render(
        <Field
          label="Email"
          name="email"
          value="x"
          onChange={noop}
          hint="We never share it."
          error="Enter an email."
        />,
      )
      const input = screen.getByLabelText('Email')
      expect(input).toBeInvalid()
      expect(input).toHaveAccessibleDescription('We never share it. Enter an email.')

      rerender(<Field label="Email" name="email" value="" onChange={noop} error={null} />)
      expect(input).toBeValid()
      expect(input).not.toHaveAccessibleDescription()
      unmount()
    }
  })

  test('a text field reports what is typed', async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [value, setValue] = useState('')
      return <TextField label="Name" name="name" value={value} onChange={setValue} />
    }
    render(<Controlled />)

    await user.type(screen.getByLabelText('Name'), 'Ada')
    expect(screen.getByLabelText('Name')).toHaveValue('Ada')
  })

  test('the password shows only once revealed, and the toggle says what it will do', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<PasswordField label="Password" name="password" value="pw" onChange={noop} />)
    const show = screen.getByRole('button', { name: 'Show password' })
    expect(show).toHaveAttribute('type', 'button')
    expect(show).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')

    rerender(<PasswordField label="Password" name="password" value="pw" onChange={noop} revealed />)
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')

    // Without `revealed`, the field keeps the state itself.
    rerender(<PasswordField label="Password" name="password" value="pw" onChange={noop} />)
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('Button and FormError', () => {
  test('a pending button is disabled and busy, and keeps its label', () => {
    const { rerender } = render(
      <Button type="submit" pending>
        Sign in
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Sign in' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')

    rerender(<Button type="submit">Sign in</Button>)
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('aria-busy')
  })

  test('a form error is an alert with its message, and nothing without one', () => {
    const { rerender } = render(<FormError message="Wrong email or password." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong email or password.')

    rerender(<FormError message={null} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    rerender(<FormError message="" />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
