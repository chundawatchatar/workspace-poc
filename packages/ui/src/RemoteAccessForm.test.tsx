import { describe, expect, mock, test } from 'bun:test'
import type { PreviewLinkResponse, RemoteAccessStatus } from '@orch/shared'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, useState } from 'react'
import { RemoteAccessForm } from './RemoteAccessForm'

const status: RemoteAccessStatus = {
  enabled: false,
  serverUrl: 'wss://relay.example.com',
  serverUrlIsDefault: false,
  clientUrl: null,
  serverUrlFromEnv: false,
  clientUrlFromEnv: true,
  machineId: 'm-1',
  tunnel: 'off',
  linkedAccount: null,
}

const preview: PreviewLinkResponse = {
  serverUrl: 'wss://relay.example.com',
  serverUrlIsDefault: false,
  account: { name: 'Ada Lovelace', maskedEmail: 'a***@example.com' },
  fingerprint: 'Wx9z',
  expiresAt: '2026-11-04T12:15:00.000Z',
}

type Props = ComponentProps<typeof RemoteAccessForm>

/** The link section's props, with a mock for every callback. */
function accountLinkProps(overrides: Partial<Props['accountLink']> = {}): Props['accountLink'] {
  return {
    linkKey: '',
    onLinkKeyChange: mock(),
    onPreview: mock(),
    preview: null,
    onLink: mock(),
    onCancel: mock(),
    onUnlink: mock(),
    ...overrides,
  }
}

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    status,
    statusLabel: 'Off',
    statusTone: 'off',
    serverUrl: 'wss://relay.example.com',
    clientUrl: '',
    onServerUrlChange: mock(),
    onClientUrlChange: mock(),
    onSave: mock(),
    onToggle: mock(),
    onNewLink: mock(),
    link: null,
    accountLink: accountLinkProps(),
    error: null,
    busy: false,
    onClose: mock(),
    ...overrides,
  }
  // The form doesn't hold the server address or the key itself; this stands in for the page that does.
  function Page() {
    const [serverUrl, setServerUrl] = useState(props.serverUrl)
    const [linkKey, setLinkKey] = useState(props.accountLink.linkKey)
    return (
      <RemoteAccessForm
        {...props}
        serverUrl={serverUrl}
        onServerUrlChange={(value) => {
          setServerUrl(value)
          props.onServerUrlChange(value)
        }}
        accountLink={{
          ...props.accountLink,
          linkKey,
          onLinkKeyChange: (value) => {
            setLinkKey(value)
            props.accountLink.onLinkKeyChange(value)
          },
        }}
      />
    )
  }
  return { props, ...render(<Page />) }
}

describe('RemoteAccessForm', () => {
  test('the switch turns it on, Save sends the edited address, and a new link can be copied', async () => {
    const user = userEvent.setup()
    const { props } = setup({ link: 'https://app.example.com/#machine=m-1&key=k' })

    await user.click(screen.getByRole('switch', { name: 'Remote access' }))
    expect(props.onToggle).toHaveBeenCalledWith(true)

    const server = screen.getByRole('textbox', { name: 'Server address' })
    await user.clear(server)
    await user.type(server, 'wss://other.example.com{Enter}')
    expect(props.onServerUrlChange).toHaveBeenLastCalledWith('wss://other.example.com')
    expect(props.onSave).toHaveBeenCalledTimes(1)

    // An address from the host's environment is shown but can't be edited.
    expect(screen.getByRole('textbox', { name: /Client address/ })).toHaveAttribute('readonly')
    expect(screen.getByText('Set by CLIENT_URL.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy the link' }))
    expect(await navigator.clipboard.readText()).toBe('https://app.example.com/#machine=m-1&key=k')
  })

  test('while busy, nothing can be sent again', async () => {
    const user = userEvent.setup()
    const { props } = setup({ busy: true })

    expect(screen.getByRole('switch', { name: 'Remote access' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New connect link' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Server address' }), '{Enter}')
    expect(props.onSave).not.toHaveBeenCalled()
  })

  test('a pasted key previews on Enter or Preview without saving the setting', async () => {
    const user = userEvent.setup()
    const { props } = setup()

    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Link key' }), 'oek_abc{Enter}')
    expect(props.accountLink.onLinkKeyChange).toHaveBeenLastCalledWith('oek_abc')
    expect(props.accountLink.onPreview).toHaveBeenCalledTimes(1)
    expect(props.onSave).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(props.accountLink.onPreview).toHaveBeenCalledTimes(2)
  })

  test('the preview shows what to check, warns about a server other than the default, and links only on Link', async () => {
    const user = userEvent.setup()
    const accountLink = accountLinkProps({ preview })
    setup({ accountLink, error: 'This key is unknown, used or expired' })

    const panel = screen.getByRole('region', { name: 'Check before linking' })
    for (const text of ['wss://relay.example.com', 'Ada Lovelace', 'a***@example.com', 'Wx9z']) {
      expect(panel).toHaveTextContent(text)
    }
    expect(screen.getByRole('alert')).toHaveTextContent('not the default server')
    expect(screen.getByText('This key is unknown, used or expired')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Link key' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(accountLink.onCancel).toHaveBeenCalledTimes(1)
    expect(accountLink.onLink).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Link' }))
    expect(accountLink.onLink).toHaveBeenCalledTimes(1)
  })

  test('the default server gets no warning', () => {
    setup({ accountLink: accountLinkProps({ preview: { ...preview, serverUrlIsDefault: true } }) })
    expect(screen.getByRole('region', { name: 'Check before linking' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('a linked machine shows its account and server with Unlink, and no key field', async () => {
    const user = userEvent.setup()
    const linkedAccount = {
      name: 'Ada Lovelace',
      maskedEmail: 'a***@example.com',
      serverUrl: 'wss://relay.example.com',
      linkedAt: '2026-11-04T12:00:00.000Z',
    }
    const { props } = setup({ status: { ...status, linkedAccount } })

    const panel = screen.getByRole('region', { name: 'Linked account' })
    expect(panel).toHaveTextContent('Linked to Ada Lovelace (a***@example.com)')
    expect(panel).toHaveTextContent('wss://relay.example.com')
    expect(screen.queryByRole('textbox', { name: 'Link key' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Unlink' }))
    expect(props.accountLink.onUnlink).toHaveBeenCalledTimes(1)
  })
})
