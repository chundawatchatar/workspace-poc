import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FolderBrowser } from './FolderBrowser'

const listing = { path: '/home/me', parent: '/home', dirs: ['code', 'notes'] }

describe('FolderBrowser', () => {
  test('opens a subfolder or the parent, and creates a folder, showing why it could not', async () => {
    const user = userEvent.setup()
    const onOpen = mock()
    const onCreateFolder = mock(async (name: string) => (name === 'code' ? 'That folder already exists.' : null))
    render(<FolderBrowser listing={listing} onOpen={onOpen} onCreateFolder={onCreateFolder} />)

    await user.click(screen.getByRole('button', { name: 'notes' }))
    expect(onOpen).toHaveBeenLastCalledWith('/home/me/notes')
    await user.click(screen.getByRole('button', { name: '..' }))
    expect(onOpen).toHaveBeenLastCalledWith('/home')

    await user.click(screen.getByRole('button', { name: 'New folder' }))
    const name = screen.getByPlaceholderText('Folder name')
    expect(name).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()

    // A failure keeps the name to fix; Enter creates rather than submitting the form around it.
    await user.type(name, 'code{Enter}')
    expect(await screen.findByText('That folder already exists.')).toBeInTheDocument()
    expect(name).toHaveValue('code')

    // Cancel drops the name and the error; the next try starts clean.
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('That folder already exists.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    expect(screen.getByPlaceholderText('Folder name')).toHaveValue('')

    await user.type(screen.getByPlaceholderText('Folder name'), 'drafts')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreateFolder).toHaveBeenLastCalledWith('drafts')
    expect(await screen.findByRole('button', { name: 'New folder' })).toBeInTheDocument()
    expect(screen.queryByText('That folder already exists.')).not.toBeInTheDocument()
  })

  test('shows the error instead of the folders, and offers no new folder without a path', () => {
    render(
      <FolderBrowser
        listing={undefined}
        error="Could not reach the host."
        onOpen={() => {}}
        onCreateFolder={async () => null}
      />,
    )
    expect(screen.getByText('Could not reach the host.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled()
  })
})
