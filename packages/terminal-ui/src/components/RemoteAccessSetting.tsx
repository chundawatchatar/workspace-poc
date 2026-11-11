import { type DevicesResponse, type PreviewLinkResponse, type RemoteAccessStatus, routes } from '@orch/shared'
import { RemoteAccessForm } from '@orch/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiKey, apiMutation, apiQuery, callApi } from '../lib/api'
import { remoteAccessLabel, requestErrorMessage } from '../lib/remoteAccess'
import { setOverlay } from '../lib/store'

/** How often the tunnel's state is asked for while the dialog is open. */
const POLL_MS = 2000

/**
 * The Remote access dialog, connected to the host's `routes.remoteAccess` and
 * `routes.access.rotate`. While an account is linked it also lists the
 * browsers approved for it, and always the browsers connected through the
 * tunnel now, both polled like the status. A link key lives only in
 * this component's state: preview and link go through `callApi`, not a
 * mutation, so it never enters TanStack Query's caches, and it is dropped on
 * link, cancel and close.
 */
export function RemoteAccessSetting() {
  const queryClient = useQueryClient()
  const status = useQuery({ ...apiQuery(routes.remoteAccess.status, {}), refetchInterval: POLL_MS, retry: false })
  const update = useMutation(apiMutation(routes.remoteAccess.update))
  const rotate = useMutation(apiMutation(routes.access.rotate))
  const unlink = useMutation(apiMutation(routes.remoteAccess.unlink))
  const linked = Boolean(status.data?.linkedAccount)
  const devices = useQuery({
    ...apiQuery(routes.remoteAccess.devices, {}),
    enabled: linked,
    refetchInterval: POLL_MS,
    retry: false,
  })
  const approveDevice = useMutation(apiMutation(routes.remoteAccess.approveDevice))
  const removeDevice = useMutation(apiMutation(routes.remoteAccess.removeDevice))
  const sessions = useQuery({ ...apiQuery(routes.remoteAccess.sessions, {}), refetchInterval: POLL_MS, retry: false })
  const endSession = useMutation(apiMutation(routes.remoteAccess.endSession))
  // What the user typed. Null means the field still shows the host's value.
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [clientUrl, setClientUrl] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linkKey, setLinkKey] = useState('')
  // The fingerprint typed into "Approve a browser", kept when the host refuses it.
  const [fingerprint, setFingerprint] = useState('')
  const [preview, setPreview] = useState<PreviewLinkResponse | null>(null)
  // True while a preview or a link is on its way.
  const [linking, setLinking] = useState(false)

  const data = status.data
  const shownServer = data?.serverUrlFromEnv ? (data.serverUrl ?? '') : (serverUrl ?? data?.serverUrl ?? '')
  const shownClient = data?.clientUrlFromEnv ? (data.clientUrl ?? '') : (clientUrl ?? data?.clientUrl ?? '')

  async function save(enabled: boolean) {
    setError(null)
    try {
      const next = await update.mutateAsync({ enabled, serverUrl: shownServer, clientUrl: shownClient || null })
      showStatus(next)
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

  function showStatus(next: RemoteAccessStatus) {
    queryClient.setQueryData(apiKey(routes.remoteAccess.status, {}), next)
  }

  /** Approves, dismisses or revokes a device, then shows the list the host answers. False when the host refused. */
  async function changeDevice(change: () => Promise<DevicesResponse>): Promise<boolean> {
    setError(null)
    try {
      queryClient.setQueryData(apiKey(routes.remoteAccess.devices, {}), await change())
      // A revoked device's sockets are closed, so its session goes too.
      void sessions.refetch()
      return true
    } catch (failure) {
      setError(requestErrorMessage(failure))
      void devices.refetch()
      return false
    }
  }

  /** Closes a device's tunneled sockets, leaving it approved, then shows the list the host answers. */
  async function endDeviceSession(id: string) {
    setError(null)
    try {
      queryClient.setQueryData(apiKey(routes.remoteAccess.sessions, {}), await endSession.mutateAsync({ id }))
    } catch (failure) {
      setError(requestErrorMessage(failure))
      void sessions.refetch()
    }
  }

  /** Sends the typed fingerprint for the host to match, and clears the field once it approved. */
  async function approveTyped(typed: string) {
    if (await changeDevice(() => approveDevice.mutateAsync({ fingerprint: typed.trim() }))) setFingerprint('')
  }

  async function previewKey() {
    setError(null)
    setLinking(true)
    try {
      setPreview(await callApi(routes.remoteAccess.previewLink, { key: linkKey.trim() }))
    } catch (failure) {
      setError(requestErrorMessage(failure))
    } finally {
      setLinking(false)
    }
  }

  async function linkAccount() {
    if (!preview) return
    setError(null)
    setLinking(true)
    const key = linkKey.trim()
    setLinkKey('')
    setPreview(null)
    try {
      showStatus(await callApi(routes.remoteAccess.link, { key, serverUrl: preview.serverUrl }))
    } catch (failure) {
      setError(requestErrorMessage(failure))
    } finally {
      setLinking(false)
    }
  }

  function cancelLink() {
    setLinkKey('')
    setPreview(null)
  }

  async function unlinkAccount() {
    setError(null)
    try {
      showStatus(await unlink.mutateAsync({}))
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
      accountLink={{
        linkKey,
        onLinkKeyChange: setLinkKey,
        onPreview: previewKey,
        preview,
        onLink: linkAccount,
        onCancel: cancelLink,
        onUnlink: unlinkAccount,
      }}
      devices={{
        devices: devices.data,
        fingerprint,
        onFingerprintChange: setFingerprint,
        onApprove: approveTyped,
        onDismiss: (id) => changeDevice(() => removeDevice.mutateAsync({ id })),
        onRevoke: (id) => changeDevice(() => removeDevice.mutateAsync({ id })),
      }}
      sessions={{ sessions: sessions.data, onEnd: endDeviceSession }}
      error={error}
      busy={
        update.isPending ||
        rotate.isPending ||
        unlink.isPending ||
        approveDevice.isPending ||
        removeDevice.isPending ||
        endSession.isPending ||
        linking
      }
      onClose={() => setOverlay(null)}
    />
  )
}
