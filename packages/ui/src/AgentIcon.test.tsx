import { describe, expect, test } from 'bun:test'
import { AGENT_LABELS, type AgentKind } from '@orch/shared'
import { render } from '@testing-library/react'
import { AGENT_ICONS, AgentIcon } from './AgentIcon'

const kinds = Object.keys(AGENT_LABELS) as AgentKind[]

/** The kinds whose vendor forbids recolouring, with the colours of their published files. */
const FIXED_COLOURS: Partial<Record<AgentKind, string[]>> = { claude: ['#D97757'], commandcode: ['#000', '#fff'] }

function renderIcon(kind: AgentKind) {
  const { container, unmount } = render(<AgentIcon kind={kind} size={10} />)
  // biome-ignore lint/plugin: the icon is decorative (`aria-hidden`), so it has no role, label or text to query by.
  const svg = container.querySelector(`[data-agent="${kind}"]`) as SVGSVGElement
  const paints = [svg, ...svg.querySelectorAll('*')].flatMap((element) =>
    ['fill', 'stroke'].map((name) => element.getAttribute(name)).filter((value) => value !== null),
  )
  return { svg, paints, unmount }
}

describe('AGENT_ICONS', () => {
  test('every agent kind has an icon, with a short label no other kind shares', () => {
    expect(kinds.filter((kind) => !AGENT_ICONS[kind])).toEqual([])
    const labels = kinds.map((kind) => AGENT_ICONS[kind].label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const label of labels) expect(label).toMatch(/^.{1,2}$/u)
  })

  test('published artwork records where it comes from and the terms that apply', () => {
    for (const kind of kinds) {
      const mark = AGENT_ICONS[kind].mark
      if (!mark) continue
      expect(mark.source).toMatch(/^https:\/\/\S+$/u)
      expect(mark.terms).toMatch(/^https:\/\/\S+$/u)
      expect(mark.termsSummary).not.toBe('')
    }
  })
})

describe('AgentIcon', () => {
  test('draws every kind decoratively at the size asked for, each looking different', () => {
    const drawings = new Set<string>()
    for (const kind of kinds) {
      const { svg, unmount } = renderIcon(kind)
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('width', '10')
      expect(svg).toHaveAttribute('height', '10')
      drawings.add(svg.innerHTML)
      unmount()
    }
    expect(drawings.size).toBe(kinds.length)
  })

  test('paints in the text colour, except a mark whose vendor fixes its colours', () => {
    for (const kind of kinds) {
      const { paints, unmount } = renderIcon(kind)
      const allowed = FIXED_COLOURS[kind] ?? ['currentColor']
      expect(paints.filter((value) => value !== 'none' && !allowed.includes(value))).toEqual([])
      expect(paints.some((value) => allowed.includes(value))).toBe(true)
      unmount()
    }
  })

  test('carries no styles, classes or ids from a vendor file, and text only in a monogram', () => {
    for (const kind of kinds) {
      const { svg, unmount } = renderIcon(kind)
      expect(svg.querySelectorAll('style, [class], [id]')).toHaveLength(0)
      expect(svg.querySelectorAll('text')).toHaveLength(AGENT_ICONS[kind].mark ? 0 : 1)
      unmount()
    }
  })
})
