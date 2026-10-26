import { routes } from '@orch/shared'
import { FolderBrowser, Modal } from '@orch/ui'
import { FolderOpen } from '@orch/ui/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { apiKey, apiMutation, apiQuery } from '../lib/api'
import { addWorkspace } from '../lib/commands'
import { LEADER_LABEL, SHORTCUT_ROWS } from '../lib/shortcuts'
import { setOverlay, useApp } from '../lib/store'
import { formatUptime } from '../lib/uptime'
import { CommandPalette } from './CommandPalette'
import { ThemePicker } from './ThemePicker'

export function Overlays() {
  const overlay = useApp((s) => s.overlay)
  if (overlay === 'help') return <ShortcutsHelp />
  if (overlay === 'new-workspace') return <NewWorkspace />
  if (overlay === 'palette') return <CommandPalette />
  if (overlay === 'themes') return <ThemePicker />
  return null
}

function ShortcutsHelp() {
  return (
    <Modal title="Keyboard shortcuts" width="w-[560px]" onClose={() => setOverlay(null)}>
      <p className="mb-3 text-xs leading-relaxed text-dim">
        Press <kbd>{LEADER_LABEL}</kbd>, release, then the key in the first column. The second column works without the
        leader. Browsers keep Ctrl/Cmd+W, T and N for themselves, so none of these use them.
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-faint">
            <th className="pb-1.5 font-medium">Action</th>
            <th className="pb-1.5 font-medium">After {LEADER_LABEL}</th>
            <th className="pb-1.5 font-medium">Direct</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUT_ROWS.map((row) => (
            <tr key={row.label} className="border-t border-line/60">
              <td className="py-1.5 pr-3">{row.label}</td>
              <td className="py-1.5 pr-3">{row.leader && <kbd>{row.leader}</kbd>}</td>
              <td className="py-1.5 text-dim">{row.direct}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <DaemonStatusLine />
    </Modal>
  )
}

/** The terminal daemon's uptime and live terminal count, fetched each time the dialog opens. */
function DaemonStatusLine() {
  // The host is local, so a failure is shown at once rather than after the default retries; reopening asks again.
  const status = useQuery({ ...apiQuery(routes.system.daemon, {}), retry: false })
  let text: string
  if (status.isPending) text = 'Terminal daemon: checking…'
  else if (status.isError) text = 'Terminal daemon status unavailable'
  else {
    const { uptimeMs, liveTerminals } = status.data
    const state = uptimeMs === null ? 'not connected' : `up ${formatUptime(uptimeMs)}`
    text = `Terminal daemon: ${state} · ${liveTerminals} live ${liveTerminals === 1 ? 'terminal' : 'terminals'}`
  }
  return <p className="mt-3 text-xs text-faint">{text}</p>
}

function NewWorkspace() {
  const home = useApp((s) => s.info?.home) ?? '~'
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [path, setPath] = useState('~')
  const [error, setError] = useState<string | null>(null)
  const resolveDir = useMutation(apiMutation(routes.fs.resolveDir))
  // The folder shown in the browser, or null while it is closed.
  const [browsePath, setBrowsePath] = useState<string | null>(null)
  const listing = useQuery({
    ...apiQuery(routes.fs.listDirs, { path: browsePath ?? '' }),
    enabled: browsePath !== null,
  })

  const makeDir = useMutation(apiMutation(routes.fs.makeDir))
  const queryClient = useQueryClient()
  const pathField = useRef<HTMLDivElement>(null)

  // Starts at the typed folder, or at home when that one doesn't exist.
  if (listing.data && listing.data.path === null && browsePath !== '~') setBrowsePath('~')

  // A click outside the folder field and its browser closes the browser.
  const browsing = browsePath !== null
  useEffect(() => {
    if (!browsing) return
    const onPointerDown = (event: PointerEvent) => {
      if (!pathField.current?.contains(event.target as Node)) setBrowsePath(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [browsing])

  function openFolder(folder: string) {
    setBrowsePath(folder)
    setPath(folder)
  }

  async function createFolder(folderName: string): Promise<string | null> {
    const parent = listing.data?.path
    if (!parent) return 'No folder is open.'
    try {
      const result = await makeDir.mutateAsync({ parent, name: folderName })
      if (!result.path) return result.error ?? 'Could not create the folder.'
      void queryClient.invalidateQueries({ queryKey: apiKey(routes.fs.listDirs) })
      openFolder(result.path)
      return null
    } catch {
      return 'Could not reach the host.'
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (resolveDir.isPending) return
    setError(null)
    try {
      const { path: resolved } = await resolveDir.mutateAsync({ path: path.trim() })
      if (!resolved) {
        setError('That folder does not exist on the host. Use an absolute path or one starting with ~.')
        return
      }
      const fallbackName = resolved === home ? 'home' : (resolved.split('/').filter(Boolean).pop() ?? 'workspace')
      const id = addWorkspace(name.trim() || fallbackName, resolved)
      setOverlay(null)
      void navigate({ to: '/w/$workspaceId', params: { workspaceId: id } })
    } catch {
      setError('Could not reach the host.')
    }
  }

  const field = 'w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-accent'

  return (
    <Modal title="New workspace" onClose={() => setOverlay(null)}>
      <form onSubmit={create} className="space-y-3">
        <div ref={pathField} className="relative">
          <label className="block">
            <span className="mb-1 block text-xs text-dim">Folder on the host</span>
            <div className="relative">
              <input
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
                className={`${field} pr-8 font-mono`}
                placeholder="~/code/my-project"
                spellCheck={false}
              />
              <button
                type="button"
                title="Browse folders"
                aria-label="Browse folders"
                aria-pressed={browsing}
                className={`absolute inset-y-px right-px flex items-center rounded-r-[5px] px-2 hover:bg-raised ${
                  browsing ? 'text-accent' : 'text-dim'
                }`}
                onClick={() => setBrowsePath(browsing ? null : path.trim() || '~')}
              >
                <FolderOpen size={15} />
              </button>
            </div>
          </label>
          {browsing && (
            <div className="absolute inset-x-0 top-full z-10 mt-1">
              <FolderBrowser
                listing={listing.data?.path ? listing.data : undefined}
                error={listing.isError ? 'Could not reach the host.' : null}
                onOpen={openFolder}
                onCreateFolder={createFolder}
              />
            </div>
          )}
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-dim">Name (optional)</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={field}
            placeholder="Defaults to the folder name"
          />
        </label>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-xs text-dim hover:bg-raised"
            onClick={() => setOverlay(null)}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={resolveDir.isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-60"
          >
            Create workspace
          </button>
        </div>
      </form>
    </Modal>
  )
}
