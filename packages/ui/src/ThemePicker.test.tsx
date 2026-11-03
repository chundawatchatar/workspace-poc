import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemePicker } from './ThemePicker'

describe('ThemePicker', () => {
  test('arrow keys move through the appearance modes and choose each one', async () => {
    const user = userEvent.setup()
    const onChoose = mock()
    render(
      <ThemePicker
        choice="system"
        themeId="dark"
        preferred={{ dark: 'dark', light: 'light' }}
        onChoose={onChoose}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    const system = await screen.findByRole('radio', { name: 'System' })
    expect(system).toHaveAttribute('aria-checked', 'true')

    system.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus()
    expect(onChoose).toHaveBeenLastCalledWith('light')
  })
})
