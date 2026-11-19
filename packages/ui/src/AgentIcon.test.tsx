import { describe, expect, test } from 'bun:test'
import { AGENT_LABELS, type AgentKind } from '@orch/shared'
import { render, screen } from '@testing-library/react'
import { AGENT_ICONS, AgentIcon } from './AgentIcon'

const kinds = Object.keys(AGENT_LABELS) as AgentKind[]

describe('AGENT_ICONS', () => {
  test('every agent kind has an icon, with a short label no other kind shares', () => {
    expect(kinds.filter((kind) => !AGENT_ICONS[kind])).toEqual([])
    const labels = kinds.map((kind) => AGENT_ICONS[kind].label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const label of labels) expect(label).toMatch(/^.{1,2}$/u)
  })
})

describe('AgentIcon', () => {
  test('draws every kind decoratively, in the text colour, at the size asked for', () => {
    for (const kind of kinds) {
      const { unmount } = render(<AgentIcon kind={kind} size={10} />)
      const svg = screen.getByText(AGENT_ICONS[kind].label).closest('svg') as SVGSVGElement
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('width', '10')
      expect(svg).toHaveAttribute('height', '10')
      const paints = [svg, ...svg.querySelectorAll('*')].flatMap((element) =>
        ['fill', 'stroke'].map((name) => element.getAttribute(name)).filter((value) => value !== null),
      )
      expect(paints).toContain('currentColor')
      expect(paints.filter((value) => value !== 'currentColor' && value !== 'none')).toEqual([])
      unmount()
    }
  })
})
