import { type DevicesResponse, type RemoteAccessStatus, routes } from '@orch/shared'
import { RemoteAccessForm } from '@orch/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiKey, apiMutation, apiQuery, callApi } from '../lib/api'
import { REMOVE_IN_CLIENT, remoteAccessLabel, requestErrorMessage } from '../lib/remoteAccess'
import { setOverlay } from '../lib/store'

/** How often the tunnel's state is asked for while the dialog is open. */
const POLL_MS = 2000

/**
 * The Remote access dialog, connected to the host's `routes.remoteAccess`.
 * While an account is connected it also lists the browsers approved for it, polled like the status. The browsers connected
 * through the tunnel now and the recent remote access are in
 * `RemoteAccessActivityDialog`, opened from the sidebar. A Connect the server
 * holds for the owner shows from the status, so it is still there after the
 * dialog is closed and opened again, and the poll picks up the owner's answer. The key and the email live only in this
 * component's state: Connect goes through `callApi`, not a mutation, so they
 * never enter TanStack Query's caches, and both are dropped once the machine
 * is linked.
 */
export function RemoteAccessSetting() {
  const queryClient = useQueryClient()
  const status = useQuery({ ...apiQuery(routes.remoteAccess.status, {}), refetchInterval: POLL_MS, retry: false })
  const disconnect = useMutation(apiMutation(routes.remoteAccess.disconnect))
  const cancelConnect = useMutation(apiMutation(routes.remoteAccess.cancelConnect))
  const linked = Boolean(status.data?.linkedAccount)
  const waiting = Boolean(status.data?.connectRequest)
  const devices = useQuery({
    ...apiQuery(routes.remoteAccess.devices, {}),
    enabled: linked,
    refetchInterval: POLL_MS,
    retry: false,
  })
  const approveDevice = useMutation(apiMutation(routes.remoteAccess.approveDevice))
  const removeDevice = useMutation(apiMutation(routes.remoteAccess.removeDevice))
  // What the user typed. Null means the field still shows the host's address in use.
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [enrollmentKey, setEnrollmentKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The fingerprint typed into "Approve a browser", kept when the host refuses it.
  const [fingerprint, setFingerprint] = useState('')
  // True while a Connect is on its way.
  const [connecting, setConnecting] = useState(false)

  const data = status.data

  // Once linked, the key is used up and the email is no longer needed, so neither stays in memory.
  useEffect(() => {
    if (!linked) return
    setEmail('')
    setEnrollmentKey('')
    setServerUrl(null)
  }, [linked])

  // An address a flag or the environment sets can't be edited, so the field shows the one in use.
  const shownServer = data?.serverUrlSetBy ? data.serverUrl : (serverUrl ?? data?.serverUrl ?? '')

  function showStatus(next: RemoteAccessStatus) {
    queryClient.setQueryData(apiKey(routes.remoteAccess.status, {}), next)
  }

  /** Approves, dismisses or revokes a device, then shows the list the host answers. False when the host refused. */
  async function changeDevice(change: () => Promise<DevicesResponse>): Promise<boolean> {
    setError(null)
    try {
      queryClient.setQueryData(apiKey(routes.remoteAccess.devices, {}), await change())
      return true
    } catch (failure) {
      setError(requestErrorMessage(failure))
      void devices.refetch()
      return false
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
    } catch (failure) {
      setError(requestErrorMessage(failure))
    } finally {
      setConnecting(false)
    }
  }

  /** Cancels the Connect that waits for the owner, then shows the status the host answers. */
  async function cancelWaiting() {
    setError(null)
    try {
      showStatus(await cancelConnect.mutateAsync({}))
    } catch (failure) {
      setError(requestErrorMessage(failure))
    }
  }

  async function disconnectAccount() {
    setError(null)
    setNotice(null)
    try {
      const { status: next, removedFromAccount } = await disconnect.mutateAsync({})
      showStatus(next)
      queryClient.setQueryData(apiKey(routes.remoteAccess.devices, {}), { pending: [], approved: [] })
      if (!removedFromAccount) setNotice(REMOVE_IN_CLIENT)
    } catch (failure) {
      setError(requestErrorMessage(failure))
    }
  }

  const { label, tone } = connecting
    ? remoteAccessLabel('connecting', false)
    : data
      ? remoteAccessLabel(data.tunnel, linked, waiting)
      : { label: status.isError ? 'Could not reach the host' : 'Checking…', tone: 'off' as const }

  return (
    <RemoteAccessForm
      status={data}
      statusLabel={label}
      statusTone={tone}
      connection={{
        serverUrl: shownServer,
        email,
        enrollmentKey,
        onServerUrlChange: setServerUrl,
        onEmailChange: setEmail,
        onEnrollmentKeyChange: setEnrollmentKey,
        onConnect: connectAccount,
        onDisconnect: disconnectAccount,
        onCancel: cancelWaiting,
      }}
      devices={{
        devices: devices.data,
        fingerprint,
        onFingerprintChange: setFingerprint,
        onApprove: approveTyped,
        onDismiss: (id) => changeDevice(() => removeDevice.mutateAsync({ id })),
        onRevoke: (id) => changeDevice(() => removeDevice.mutateAsync({ id })),
      }}
      error={error}
      notice={notice}
      busy={
        disconnect.isPending ||
        cancelConnect.isPending ||
        approveDevice.isPending ||
        removeDevice.isPending ||
        connecting
      }
      onClose={() => setOverlay(null)}
    />
  )
}
