import type { DirListing } from '@orch/shared'
import { useState } from 'react'
import { CornerLeftUp, Folder, FolderPlus } from './icons'

interface Props {
  /** The folder being shown, or undefined while it loads. */
  listing: DirListing | undefined
  error?: string | null
  /** Called with the absolute path of the folder to open. */
  onOpen: (path: string) => void
  /** Creates `name` in the shown folder. Resolves to an error message, or null on success. */
  onCreateFolder: (name: string) => Promise<string | null>
}

/** A list of a host folder's subfolders, with a row to go up a level and a way to create one. Clicking a folder opens it. */
export function FolderBrowser({ listing, error, onOpen, onCreateFolder }: Props) {
  // The new folder's name, or null while the name field is hidden.
  const [newName, setNewName] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const row = 'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] hover:bg-raised'
  const path = listing?.path

  async function create() {
    if (newName === null || creating) return
    setCreating(true)
    const message = await onCreateFolder(newName)
    setCreating(false)
    setCreateError(message)
    if (!message) setNewName(null)
  }

  function cancel() {
    setNewName(null)
    setCreateError(null)
  }

  return (
    <div className="rounded-md border border-line bg-sidebar shadow-xl">
      <div className="truncate border-b border-line px-2.5 py-1.5 font-mono text-[11px] text-dim" title={path ?? ''}>
        {path ?? '…'}
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {error ? (
          <p className="px-2 py-1 text-xs text-bad">{error}</p>
        ) : !listing ? (
          <p className="px-2 py-1 text-xs text-faint">Loading…</p>
        ) : (
          <>
            {listing.parent && (
              <button type="button" className={`${row} text-dim`} onClick={() => onOpen(listing.parent ?? '/')}>
                <CornerLeftUp size={13} />
                ..
              </button>
            )}
            {path &&
              listing.dirs.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={row}
                  onClick={() => onOpen(path === '/' ? `/${name}` : `${path}/${name}`)}
                >
                  <Folder size={13} className="shrink-0 text-accent" />
                  <span className="truncate">{name}</span>
                </button>
              ))}
            {listing.dirs.length === 0 && <p className="px-2 py-1 text-xs text-faint">No subfolders</p>}
          </>
        )}
      </div>
      <div className="border-t border-line p-1.5">
        {newName === null ? (
          <button
            type="button"
            disabled={!path}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-dim hover:bg-raised hover:text-ink disabled:opacity-50"
            onClick={() => setNewName('')}
          >
            <FolderPlus size={13} />
            New folder
          </button>
        ) : (
          <div className="space-y-1">
            <div className="flex gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  // Enter would submit the dialog's form, so it creates the folder instead.
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void create()
                  }
                }}
                placeholder="Folder name"
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
              />
              <button
                type="button"
                disabled={creating || !newName.trim()}
                className="rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent disabled:opacity-60"
                onClick={() => void create()}
              >
                Create
              </button>
              <button type="button" className="rounded px-2 py-1 text-xs text-dim hover:bg-raised" onClick={cancel}>
                Cancel
              </button>
            </div>
            {createError && <p className="px-0.5 text-xs text-bad">{createError}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
