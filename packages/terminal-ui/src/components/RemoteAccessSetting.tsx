import { type DevicesResponse, machineFingerprint, type RemoteAccessStatus, routes } from '@orch/shared'
import { RemoteAccessForm } from '@orch/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiKey, apiMutation, apiQuery, callApi } from '../lib/api'
import { REMOVE_IN_CLIENT, remoteAccessLabel, requestErrorMessage } from '../lib/remoteAccess'
import { setOverlay } from '../lib/store'

/** How often the tunnel's state is asked for while the dialog is open. */
const POLL_MS = 2000

/**
 * The Remote access dialog, connected to the host's `routes.remoteAccess` and
 * `routes.access.rotate`. While an account is connected it also lists the
 * browsers approved for it, and always the browsers connected through the
 * tunnel now and the recent remote access the host recorded, all polled like
 * the status. The key and the email live only in this component's state:
 * Connect goes through `callApi`, not a mutation, so they never enter TanStack
 * Query's caches, and both are dropped once it succeeds.
 */
export function RemoteAccessSetting() {
  const queryClient = useQueryClient()
  const status = useQuery({ ...apiQuery(routes.remoteAccess.status, {}), refetchInterval: POLL_MS, retry: false })
  const rotate = useMutation(apiMutation(routes.access.rotate))
  const disconnect = useMutation(apiMutation(routes.remoteAccess.disconnect))
  const linked = Boolean(status.data?.linkedAccount)
  const devices = useQuery({
    ...apiQuery(routes.remoteAccess.devices, {}),
    enabled: linked,
    refetchInterval: POLL_MS,
    retry: false,
  })
  const auditLog = useQuery({ ...apiQuery(routes.remoteAccess.auditLog, {}), refetchInterval: POLL_MS, retry: false })
  const approveDevice = useMutation(apiMutation(routes.remoteAccess.approveDevice))
  const removeDevice = useMutation(apiMutation(routes.remoteAccess.removeDevice))
  const sessions = useQuery({ ...apiQuery(routes.remoteAccess.sessions, {}), refetchInterval: POLL_MS, retry: false })
  const endSession = useMutation(apiMutation(routes.remoteAccess.endSession))
  // What the user typed. Null means the field still shows the host's address in use.
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [enrollmentKey, setEnrollmentKey] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The fingerprint typed into "Approve a browser", kept when the host refuses it.
  const [fingerprint, setFingerprint] = useState('')
  // True while a Connect is on its way.
  const [connecting, setConnecting] = useState(false)

  const data = status.data
  // An address a flag or the environment sets can't be edited, so the field shows the one in use.
  const shownServer = data?.serverUrlSetBy ? data.serverUrl : (serverUrl ?? data?.serverUrl ?? '')

  async function newLink() {
    setError(null)
    setNotice(null)
    try {
      const result = await rotate.mutateAsync({})
      const fingerprint = machineFingerprint(result.machineId)
      setLink(result.link ?? `Machine id: ${result.machineId}  Machine key: ${fingerprint}  Access key: ${result.key}`)
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

  async function connectAccount() {
    setError(null)
    setNotice(null)
    setConnecting(true)
    try {
      const next = await callApi(routes.remoteAccess.connect, {
        email: email.trim(),
        key: enrollmentKey.trim(),
        serverUrl: shownServer.trim(),
      })
      showStatus(next)
      setEmail('')
      setEnrollmentKey('')
      setServerUrl(null)
    } catch (failure) {
      setError(requestErrorMessage(failure))
    } finally {
      setConnecting(false)
    }
  }

  async function disconnectAccount() {
    setError(null)
    setNotice(null)
    try {
      const { status: next, removedFromAccount } = await disconnect.mutateAsync({})
      showStatus(next)
      queryClient.setQueryData(apiKey(routes.remoteAccess.devices, {}), { pending: [], approved: [] })
      void sessions.refetch()
      if (!removedFromAccount) setNotice(REMOVE_IN_CLIENT)
    } catch (failure) {
      setError(requestErrorMessage(failure))
    }
  }

  const { label, tone } = connecting
    ? remoteAccessLabel('connecting', false)
    : data
      ? remoteAccessLabel(data.tunnel, linked)
      : { label: status.isError ? 'Could not reach the host' : 'Checking…', tone: 'off' as const }

  return (
    <RemoteAccessForm
      status={data}
      statusLabel={label}
      statusTone={tone}
      onNewLink={newLink}
      link={link}
      connection={{
        serverUrl: shownServer,
        email,
        enrollmentKey,
        onServerUrlChange: setServerUrl,
        onEmailChange: setEmail,
        onEnrollmentKeyChange: setEnrollmentKey,
        onConnect: connectAccount,
        onDisconnect: disconnectAccount,
      }}
      devices={{
        devices: devices.data,
        fingerprint,
        onFingerprintChange: setFingerprint,
        onApprove: approveTyped,
        onDismiss: (id) => changeDevice(() => removeDevice.mutateAsync({ id })),
        onRevoke: (id) => changeDevice(() => removeDevice.mutateAsync({ id })),
      }}
      activity={{ entries: auditLog.data?.entries, failed: auditLog.isError }}
      sessions={{ sessions: sessions.data, onEnd: endDeviceSession }}
      error={error}
      notice={notice}
      busy={
        rotate.isPending ||
        disconnect.isPending ||
        approveDevice.isPending ||
        removeDevice.isPending ||
        endSession.isPending ||
        connecting
      }
      onClose={() => setOverlay(null)}
    />
  )
}
