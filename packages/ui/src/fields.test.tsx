import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from './Button'
import { FormError } from './FormError'
import { PasswordField } from './PasswordField'
import { TextField } from './TextField'

const noop = () => {}

/** Renders `element` to HTML, with a reader for the first matching tag's attribute. */
function render(element: ReactElement) {
  const html = renderToStaticMarkup(element)
  const attr = (tag: string, name: string) => html.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`))?.[1]
  return { html, attr }
}

describe('TextField and PasswordField', () => {
  test('an error marks the input invalid and describes it; the label names the input', () => {
    for (const Field of [TextField, PasswordField]) {
      const { html, attr } = render(
        <Field
          label="Email"
          name="email"
          value="x"
          onChange={noop}
          hint="We never share it."
          error="Enter an email."
        />,
      )
      const id = attr('input', 'id')
      expect(id).toBeTruthy()
      expect(attr('label', 'for')).toBe(id)
      expect(attr('input', 'aria-invalid')).toBe('true')
      const describedBy = attr('input', 'aria-describedby')?.split(' ') ?? []
      const errorId = html.match(/<p id="([^"]+)"[^>]*>Enter an email\.<\/p>/)?.[1]
      expect(errorId).toBeTruthy()
      expect(describedBy).toContain(errorId as string)
      expect(describedBy).toHaveLength(2)

      const valid = render(<Field label="Email" name="email" value="" onChange={noop} error={null} />)
      expect(valid.html).not.toContain('aria-invalid')
      expect(valid.html).not.toContain('aria-describedby')
    }
  })

  test('the password shows only once revealed, and the toggle says what it will do', () => {
    const hidden = render(<PasswordField label="Password" name="password" value="pw" onChange={noop} />)
    expect(hidden.attr('input', 'type')).toBe('password')
    expect(hidden.attr('button', 'type')).toBe('button')
    expect(hidden.attr('button', 'aria-label')).toBe('Show password')
    expect(hidden.attr('button', 'aria-pressed')).toBe('false')

    const shown = render(<PasswordField label="Password" name="password" value="pw" onChange={noop} revealed />)
    expect(shown.attr('input', 'type')).toBe('text')
    expect(shown.attr('button', 'aria-label')).toBe('Hide password')
    expect(shown.attr('button', 'aria-pressed')).toBe('true')
  })
})

describe('Button and FormError', () => {
  test('a pending button is disabled and busy, and keeps its label', () => {
    const { html, attr } = render(
      <Button type="submit" pending>
        Sign in
      </Button>,
    )
    expect(attr('button', 'aria-busy')).toBe('true')
    expect(html).toMatch(/<button[^>]*\bdisabled=""/)
    expect(html).toContain('Sign in')
    expect(render(<Button>Sign in</Button>).html).not.toMatch(/ disabled=| aria-busy=/)
  })

  test('a form error is an alert, and nothing without a message', () => {
    expect(render(<FormError message="Wrong email or password." />).html).toMatch(
      /^<p role="alert"[^>]*>Wrong email or password\.<\/p>$/,
    )
    expect(render(<FormError message={null} />).html).toBe('')
    expect(render(<FormError message="" />).html).toBe('')
  })
})
