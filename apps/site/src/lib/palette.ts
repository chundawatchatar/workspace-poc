// Command palette entries. Plain data, so Astro can pass them to the island as props.

export type PaletteAction = 'toggle-theme' | 'themes' | 'help' | 'copy-install' | 'sidebar'

export interface PaletteItem {
  id: string
  label: string
  kind: 'section' | 'page' | 'doc' | 'command'
  detail?: string
  keys?: string
  href?: string
  action?: PaletteAction
}

/** Matches when every word of the query appears in the label or detail, in any order. */
export function matches(item: PaletteItem, query: string) {
  const haystack = `${item.label} ${item.detail ?? ''} ${item.kind}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}
