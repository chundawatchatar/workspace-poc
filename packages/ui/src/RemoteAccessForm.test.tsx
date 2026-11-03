import { describe, expect, mock, test } from 'bun:test'
import type { RemoteAccessStatus } from '@orch/shared'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, useState } from 'react'
import { RemoteAccessForm } from './RemoteAccessForm'

const status: RemoteAccessStatus = {
  enabled: false,
  serverUrl: 'wss://relay.example.com',
  clientUrl: null,
  serverUrlFromEnv: false,
  clientUrlFromEnv: true,
  machineId: 'm-1',
  tunnel: 'off',
}

type Props = ComponentProps<typeof RemoteAccessForm>

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
    error: null,
    busy: false,
    onClose: mock(),
    ...overrides,
  }
  // The form doesn't hold the server address itself; this stands in for the page that does.
  function Page() {
    const [serverUrl, setServerUrl] = useState(props.serverUrl)
    return (
      <RemoteAccessForm
        {...props}
        serverUrl={serverUrl}
        onServerUrlChange={(value) => {
          setServerUrl(value)
          props.onServerUrlChange(value)
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
})
