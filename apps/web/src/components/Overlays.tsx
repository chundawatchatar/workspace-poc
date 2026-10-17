import { routes } from '@orch/shared'
import { Modal } from '@orch/ui'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { callApi } from '../lib/api'
import { addWorkspace } from '../lib/commands'
import { LEADER_LABEL, SHORTCUT_ROWS } from '../lib/shortcuts'
import { setOverlay, useApp } from '../lib/store'
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
    </Modal>
  )
}

function NewWorkspace() {
  const home = useApp((s) => s.info?.home) ?? '~'
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [path, setPath] = useState('~')
  const [error, setError] = useState<string | null>(null)

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      const { path: resolved } = await callApi(routes.fs.resolveDir, { path: path.trim() })
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
        <label className="block">
          <span className="mb-1 block text-xs text-dim">Folder on the host</span>
          <input
            autoFocus
            value={path}
            onChange={(event) => setPath(event.target.value)}
            className={`${field} font-mono`}
            placeholder="~/code/my-project"
            spellCheck={false}
          />
        </label>
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
          <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent">
            Create workspace
          </button>
        </div>
      </form>
    </Modal>
  )
}
