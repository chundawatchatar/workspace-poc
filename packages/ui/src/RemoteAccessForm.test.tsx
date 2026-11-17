import { describe, expect, mock, test } from 'bun:test'
import type { DevicesResponse, LinkedAccount, RemoteAccessStatus } from '@orch/shared'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, useState } from 'react'
import { RemoteAccessForm } from './RemoteAccessForm'

const status: RemoteAccessStatus = {
  serverUrl: 'wss://orch.example.com',
  serverUrlIsDefault: true,
  defaultServerUrl: 'wss://orch.example.com',
  clientUrl: null,
  serverUrlSetBy: null,
  clientUrlSetBy: 'CLIENT_URL',
  machineId: 'm-1',
  machineFingerprint: 'ABCD-EFGH-JKMN-PQRS',
  tunnel: 'off',
  linkedAccount: null,
}

const linkedAccount: LinkedAccount = {
  name: 'Ada Lovelace',
  maskedEmail: 'a***@example.com',
  serverUrl: 'wss://relay.example.com',
  linkedAt: '2026-11-04T12:00:00.000Z',
}

const key = `oek_${'k'.repeat(39)}Wx9z`

type Props = ComponentProps<typeof RemoteAccessForm>

/** The connect section's props, with a mock for every callback. */
function connection(overrides: Partial<Props['connection']> = {}): Props['connection'] {
  return {
    serverUrl: 'wss://orch.example.com',
    email: '',
    enrollmentKey: '',
    onServerUrlChange: mock(),
    onEmailChange: mock(),
    onEnrollmentKeyChange: mock(),
    onConnect: mock(),
    onDisconnect: mock(),
    ...overrides,
  }
}

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    status,
    statusLabel: 'Not connected',
    statusTone: 'off',
    onNewLink: mock(),
    link: null,
    connection: connection(),
    devices: {
      devices: undefined,
      fingerprint: '',
      onFingerprintChange: mock(),
      onApprove: mock(),
      onDismiss: mock(),
      onRevoke: mock(),
    },
    activity: { entries: [], failed: false },
    error: null,
    notice: null,
    busy: false,
    onClose: mock(),
    ...overrides,
  }
  // The form doesn't hold the fields itself; this stands in for the page that does.
  function Page() {
    const [serverUrl, setServerUrl] = useState(props.connection.serverUrl)
    const [email, setEmail] = useState(props.connection.email)
    const [enrollmentKey, setEnrollmentKey] = useState(props.connection.enrollmentKey)
    const [fingerprint, setFingerprint] = useState(props.devices.fingerprint)
    return (
      <RemoteAccessForm
        {...props}
        connection={{
          ...props.connection,
          serverUrl,
          email,
          enrollmentKey,
          onServerUrlChange: setServerUrl,
          onEmailChange: setEmail,
          onEnrollmentKeyChange: setEnrollmentKey,
        }}
        devices={{
          ...props.devices,
          fingerprint,
          onFingerprintChange: (value) => {
            setFingerprint(value)
            props.devices.onFingerprintChange(value)
          },
        }}
      />
    )
  }
  return { props, ...render(<Page />) }
}

describe('RemoteAccessForm', () => {
  test('Connect waits for all three fields, shows what to check with only the key ending, and connects on Connect', async () => {
    const user = userEvent.setup()
    const { props } = setup()
    // The fingerprint the client asks the owner to compare shows beside the machine id.
    expect(screen.getByText('m-1')).toBeInTheDocument()
    expect(screen.getByText('Machine key ABCD-EFGH-JKMN-PQRS')).toHaveAttribute(
      'title',
      expect.stringMatching(/fingerprint/),
    )
    // The switch, the client address and Save are gone.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /Client address/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()

    const connect = screen.getByRole('button', { name: 'Connect' })
    expect(connect).toBeDisabled()
    const server = screen.getByRole('textbox', { name: 'Server address' })
    expect(server).toHaveValue('wss://orch.example.com')
    expect(server).not.toHaveAttribute('readonly')
    await user.clear(server)
    await user.type(server, 'wss://relay.example.com')
    await user.type(screen.getByRole('textbox', { name: 'Email' }), ' ada@example.com ')
    expect(connect).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Key' }), `${key}{Enter}`)

    const check = screen.getByRole('region', { name: 'Check before connecting' })
    for (const text of ['ada@example.com', 'wss://relay.example.com', 'Wx9z']) expect(check).toHaveTextContent(text)
    expect(check.textContent).not.toContain(key)
    expect(document.body.textContent).not.toContain(key)
    expect(within(check).getByRole('alert')).toHaveTextContent('not the default server')
    expect(props.connection.onConnect).not.toHaveBeenCalled()

    // Back keeps what was typed.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('textbox', { name: 'Key' })).toHaveValue(key)
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await user.click(
      within(screen.getByRole('region', { name: 'Check before connecting' })).getByRole('button', { name: 'Connect' }),
    )
    expect(props.connection.onConnect).toHaveBeenCalledTimes(1)
  })

  test('an address a flag or variable sets is read-only and names it, and the default gets no warning', async () => {
    const user = userEvent.setup()
    for (const setBy of ['SERVER_URL', '--relay-url', 'CORCH_RELAY_URL']) {
      const { unmount } = setup({ status: { ...status, serverUrlSetBy: setBy } })
      expect(screen.getByRole('textbox', { name: 'Server address' })).toHaveAttribute('readonly')
      expect(screen.getByText(`Set by ${setBy}.`)).toBeInTheDocument()
      unmount()
    }
    setup({ connection: connection({ email: 'a@example.com', enrollmentKey: key }) })
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByRole('region', { name: 'Check before connecting' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('while busy, nothing can be sent again, and a notice shows beside the result', async () => {
    const user = userEvent.setup()
    const notice = "The server did not remove this machine from your account's list. Remove it in the client."
    const { props } = setup({ busy: true, notice })
    expect(screen.getByRole('button', { name: 'New connect link' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'a@example.com')
    await user.type(screen.getByRole('textbox', { name: 'Key' }), `${key}{Enter}`)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    expect(screen.queryByRole('region', { name: 'Check before connecting' })).not.toBeInTheDocument()
    expect(props.connection.onConnect).not.toHaveBeenCalled()
    expect(screen.getByText(notice)).toBeInTheDocument()
  })

  test('connected shows the account and its server, no field to edit, and Disconnect asks first', async () => {
    const user = userEvent.setup()
    const { props } = setup({
      status: { ...status, tunnel: 'connected', linkedAccount },
      statusLabel: 'Connected',
      statusTone: 'good',
      link: 'https://app.example.com/#machine=m-1&key=k',
    })
    expect(screen.getByRole('status')).toHaveTextContent('Connected')
    const panel = screen.getByRole('region', { name: 'Connected account' })
    expect(panel).toHaveTextContent('Ada Lovelace (a***@example.com)')
    expect(panel).toHaveTextContent('wss://relay.example.com')
    for (const name of ['Server address', 'Email', 'Key']) {
      expect(screen.queryByRole('textbox', { name })).not.toBeInTheDocument()
    }

    await user.click(within(panel).getByRole('button', { name: 'Disconnect' }))
    const confirm = within(panel).getByRole('group', { name: 'Confirm disconnect' })
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(props.connection.onDisconnect).not.toHaveBeenCalled()
    await user.click(within(panel).getByRole('button', { name: 'Disconnect' }))
    await user.click(within(panel).getByRole('button', { name: 'Disconnect' }))
    expect(props.connection.onDisconnect).toHaveBeenCalledTimes(1)

    // A new connect link can still be copied.
    await user.click(screen.getByRole('button', { name: 'Copy the link' }))
    expect(await navigator.clipboard.readText()).toBe('https://app.example.com/#machine=m-1&key=k')
  })

  test('Sessions shows once an account is connected or a session is listed', () => {
    const none = { sessions: { sessions: [] }, onEnd: mock() }
    const { unmount } = setup({ sessions: none })
    expect(screen.queryByRole('region', { name: 'Sessions' })).not.toBeInTheDocument()
    unmount()

    const session = {
      deviceId: `a${'d'.repeat(42)}`,
      fingerprint: 'ABCD-EFGH',
      credentials: [{ kind: 'key' as const, name: 'laptop' }],
      sockets: 1,
      startedAt: '2026-11-06T12:00:00.000Z',
    }
    setup({ sessions: { ...none, sessions: { sessions: [session] } } })
    expect(screen.getByRole('region', { name: 'Sessions' })).toHaveTextContent('Key laptop')
  })

  test('a waiting browser can only be dismissed, and is approved only by typing its fingerprint', async () => {
    const user = userEvent.setup()
    const devices: DevicesResponse = {
      pending: [{ id: 'd'.repeat(43), fingerprint: 'ABCD-EFGH-JKMN-PQRS', firstSeenAt: '2026-11-04T12:00:00.000Z' }],
      approved: [],
    }
    const onDevices = { onFingerprintChange: mock(), onApprove: mock(), onDismiss: mock(), onRevoke: mock() }
    const { props } = setup({
      status: { ...status, linkedAccount },
      devices: { devices, fingerprint: '', ...onDevices },
    })

    const waiting = screen.getByRole('list', { name: 'Waiting for approval' })
    expect(
      within(waiting)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Dismiss'])
    await user.click(within(waiting).getByRole('button', { name: 'Dismiss ABCD-EFGH-JKMN-PQRS' }))
    expect(onDevices.onDismiss).toHaveBeenCalledWith('d'.repeat(43))

    const approve = within(screen.getByRole('group', { name: 'Approve a browser' }))
    expect(approve.getByRole('button', { name: 'Approve' })).toBeDisabled()
    const field = approve.getByRole('textbox', { name: 'Fingerprint shown in your browser' })
    await user.type(field, '   {Enter}')
    expect(onDevices.onApprove).not.toHaveBeenCalled()

    await user.clear(field)
    await user.type(field, 'abcd-efgh-jkmn-pqrs{Enter}')
    expect(onDevices.onApprove).toHaveBeenCalledWith('abcd-efgh-jkmn-pqrs')
    expect(props.connection.onDisconnect).not.toHaveBeenCalled()
    await user.click(approve.getByRole('button', { name: 'Approve' }))
    expect(onDevices.onApprove).toHaveBeenCalledTimes(2)
  })
})
