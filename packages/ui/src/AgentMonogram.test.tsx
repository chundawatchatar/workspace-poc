import { expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { AgentMonogram } from './AgentMonogram'

test('draws the fallback initials without registered artwork', () => {
  render(
    <svg aria-hidden="true">
      <AgentMonogram label="CX" />
    </svg>,
  )
  expect(screen.getByText('CX')).toBeInTheDocument()
})
