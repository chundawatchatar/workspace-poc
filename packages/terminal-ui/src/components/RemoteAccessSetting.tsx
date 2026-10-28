import { routes } from '@orch/shared'
import { RemoteAccessForm } from '@orch/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiKey, apiMutation, apiQuery } from '../lib/api'
import { remoteAccessLabel, requestErrorMessage } from '../lib/remoteAccess'
import { setOverlay } from '../lib/store'

/** How often the tunnel's state is asked for while the dialog is open. */
const POLL_MS = 2000

/** The Remote access dialog, connected to the host's `routes.remoteAccess` and `routes.access.rotate`. */
export function RemoteAccessSetting() {
  const queryClient = useQueryClient()
  const status = useQuery({ ...apiQuery(routes.remoteAccess.status, {}), refetchInterval: POLL_MS, retry: false })
  const update = useMutation(apiMutation(routes.remoteAccess.update))
  const rotate = useMutation(apiMutation(routes.access.rotate))
  // What the user typed. Null means the field still shows the host's value.
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [clientUrl, setClientUrl] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const data = status.data
  const shownServer = data?.serverUrlFromEnv ? (data.serverUrl ?? '') : (serverUrl ?? data?.serverUrl ?? '')
  const shownClient = data?.clientUrlFromEnv ? (data.clientUrl ?? '') : (clientUrl ?? data?.clientUrl ?? '')

  async function save(enabled: boolean) {
    setError(null)
    try {
      const next = await update.mutateAsync({ enabled, serverUrl: shownServer, clientUrl: shownClient || null })
      queryClient.setQueryData(apiKey(routes.remoteAccess.status, {}), next)
      setServerUrl(null)
      setClientUrl(null)
    } catch (failure) {
      setError(requestErrorMessage(failure))
    }
  }

  async function newLink() {
    setError(null)
    try {
      const result = await rotate.mutateAsync({})
      setLink(result.link ?? `Machine id: ${result.machineId}  Access key: ${result.key}`)
    } catch (failure) {
      setError(requestErrorMessage(failure))
    }
  }

  const { label, tone } = data
    ? remoteAccessLabel(data.tunnel)
    : { label: status.isError ? 'Could not reach the host' : 'Checking…', tone: 'off' as const }

  return (
    <RemoteAccessForm
      status={data}
      statusLabel={label}
      statusTone={tone}
      serverUrl={shownServer}
      clientUrl={shownClient}
      onServerUrlChange={setServerUrl}
      onClientUrlChange={setClientUrl}
      onSave={() => save(data?.enabled ?? false)}
      onToggle={save}
      onNewLink={newLink}
      link={link}
      error={error}
      busy={update.isPending || rotate.isPending}
      onClose={() => setOverlay(null)}
    />
  )
}
