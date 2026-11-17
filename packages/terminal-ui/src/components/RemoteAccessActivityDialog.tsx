import { routes } from '@orch/shared'
import { Modal, RemoteAccessActivity, RemoteAccessSessions, showToast } from '@orch/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiKey, apiMutation, apiQuery } from '../lib/api'
import { requestErrorMessage } from '../lib/remoteAccess'
import { setOverlay } from '../lib/store'

/** How often the sessions and the audit log are asked for while the dialog is open. */
const POLL_MS = 2000

/**
 * The browsers connected through the tunnel now, with End, and the recent
 * remote access the host recorded, both polled while the dialog is open. It
 * opens from the remote access status in the sidebar. A failed End is shown
 * as a toast, and the list is read again.
 */
export function RemoteAccessActivityDialog() {
  const queryClient = useQueryClient()
  const sessions = useQuery({ ...apiQuery(routes.remoteAccess.sessions, {}), refetchInterval: POLL_MS, retry: false })
  const auditLog = useQuery({ ...apiQuery(routes.remoteAccess.auditLog, {}), refetchInterval: POLL_MS, retry: false })
  const endSession = useMutation(apiMutation(routes.remoteAccess.endSession))
  const close = () => setOverlay(null)

  /** Closes a device's tunneled sockets, leaving it approved, then shows the list the host answers. */
  async function end(id: string) {
    try {
      queryClient.setQueryData(apiKey(routes.remoteAccess.sessions, {}), await endSession.mutateAsync({ id }))
    } catch (failure) {
      showToast(requestErrorMessage(failure), 'error')
      void sessions.refetch()
    }
  }

  return (
    <Modal title="Remote access activity" width="w-[520px] max-w-[94vw]" onClose={close}>
      <div className="space-y-3">
        <RemoteAccessSessions sessions={sessions.data} onEnd={end} busy={endSession.isPending} />
        <RemoteAccessActivity entries={auditLog.data?.entries} failed={auditLog.isError} />
        <div className="flex justify-end pt-1">
          <button type="button" className="rounded-md px-3 py-1.5 text-xs text-dim hover:bg-raised" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
