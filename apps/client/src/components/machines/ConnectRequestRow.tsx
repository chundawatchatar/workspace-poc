import { type ConnectRequest, machineFingerprint, type ServerMachine } from '@orch/shared'
import { Button, showToast } from '@orch/ui'
import { Monitor } from '@orch/ui/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { acceptRequestMutation, rejectRequestMutation, requestAnswerFailed } from '../../lib/accountMachines'

/**
 * A machine waiting for the owner to accept or reject its Connect: its name, and the fingerprint of its id, worked
 * out here rather than taken from the server, for the owner to compare with the Machine key the machine shows. Accept
 * links it and Reject refuses it; a request that stopped waiting, or a failure, is reported with a toast.
 */
export function ConnectRequestRow({
  request,
  userId,
  onAccepted,
  onRejected,
}: {
  request: ConnectRequest
  userId: string
  onAccepted: (machine: ServerMachine) => void
  onRejected: (request: ConnectRequest) => void
}) {
  const queryClient = useQueryClient()
  const accept = useMutation(acceptRequestMutation(queryClient, userId))
  const reject = useMutation(rejectRequestMutation(queryClient, userId))
  const { id, name } = request
  const pending = accept.isPending || reject.isPending
  const failed = (error: unknown) => showToast(requestAnswerFailed(error), 'error')

  return (
    <div aria-label={`Connect request from ${name}`} role="group" className="flex flex-col gap-2 text-[13px]">
      <div className="flex items-center gap-3">
        <Monitor size={15} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <Button
          aria-label={`Accept ${name}`}
          disabled={pending}
          pending={accept.isPending}
          onClick={() => accept.mutate({ id }, { onSuccess: onAccepted, onError: failed })}
        >
          Accept
        </Button>
        <Button
          variant="secondary"
          aria-label={`Reject ${name}`}
          disabled={pending}
          pending={reject.isPending}
          onClick={() => reject.mutate({ id }, { onSuccess: () => onRejected(request), onError: failed })}
        >
          Reject
        </Button>
      </div>
      <p className="text-xs text-dim">
        Machine key <span className="font-mono text-ink">{machineFingerprint(request.machineId)}</span>. Accept only if
        it matches the Machine key the machine shows.
      </p>
    </div>
  )
}
