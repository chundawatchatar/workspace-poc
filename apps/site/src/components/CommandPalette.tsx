import { BookOpen, FileText, Hash, Search, SquareTerminal } from '@orch/ui/icons'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { matches, type PaletteItem } from '../lib/palette'

const ICONS: Record<PaletteItem['kind'], ReactNode> = {
  section: <Hash size={14} />,
  page: <FileText size={14} />,
  doc: <BookOpen size={14} />,
  command: <SquareTerminal size={14} />,
}

/** The app's command palette, searching the site's sections, pages, docs and commands. */
export function CommandPalette(props: {
  items: PaletteItem[]
  onRun: (item: PaletteItem) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const visible = props.items.filter((item) => matches(item, query))
  const selected = Math.min(index, Math.max(visible.length - 1, 0))

  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  })

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex(visible.length ? (selected + 1) % visible.length : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex(visible.length ? (selected - 1 + visible.length) % visible.length : 0)
    } else if (event.key === 'Enter' && visible[selected]) {
      event.preventDefault()
      props.onRun(visible[selected])
    }
  }

  return (
    <div
      className="anim-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[12vh]"
      onPointerDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="anim-dialog flex max-h-[62vh] w-[580px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line bg-sidebar shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={visible[selected] ? `palette-${visible[selected].id}` : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setIndex(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search sections, docs and commands"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
          <kbd>Esc</kbd>
        </div>
        <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {visible.length === 0 && <div className="px-3 py-6 text-center text-xs text-dim">No matches.</div>}
          {visible.map((item, i) => (
            <div
              key={item.id}
              id={`palette-${item.id}`}
              role="option"
              aria-selected={i === selected}
              data-selected={i === selected}
              className={`flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 ${
                i === selected ? 'bg-accent text-on-accent' : 'text-ink'
              }`}
              onPointerMove={() => i !== selected && setIndex(i)}
              onClick={() => props.onRun(item)}
            >
              <span className={i === selected ? 'text-on-accent/80' : 'text-dim'}>{ICONS[item.kind]}</span>
              <span className="shrink-0 text-[13px]">{item.label}</span>
              {item.detail && (
                <span
                  className={`hidden min-w-0 truncate text-xs sm:inline ${i === selected ? 'text-on-accent/70' : 'text-faint'}`}
                >
                  {item.detail}
                </span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {item.keys && (
                  <span className={`font-mono text-[11px] ${i === selected ? 'text-on-accent/80' : 'text-dim'}`}>
                    {item.keys}
                  </span>
                )}
                <span
                  className={`w-[64px] text-right text-[10px] tracking-wide uppercase ${
                    i === selected ? 'text-on-accent/60' : 'text-faint'
                  }`}
                >
                  {item.kind}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
