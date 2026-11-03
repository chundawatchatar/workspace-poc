import { describe, expect, mock, test } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Copy, Trash2 } from './icons'
import {
  ContextMenu,
  ContextMenuPopup,
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuTrigger,
} from './Menu'

describe('Menu', () => {
  test('a trigger opens the menu, arrows and Enter choose an item, and Escape closes it back onto the trigger', async () => {
    const user = userEvent.setup()
    const onCopy = mock()
    const onDelete = mock()
    render(
      <Menu>
        <MenuTrigger>Actions</MenuTrigger>
        <MenuPopup aria-label="Tab actions">
          <MenuItem icon={<Copy size={13} />} onClick={onCopy}>
            Copy
          </MenuItem>
          <MenuItem icon={<Trash2 size={13} />} onClick={onDelete}>
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })

    await user.click(trigger)
    expect(await screen.findByRole('menu', { name: 'Tab actions' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy', 'Delete'])

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onCopy).not.toHaveBeenCalled()
    await waitForMenuToClose()

    await user.click(trigger)
    await screen.findByRole('menu', { name: 'Tab actions' })
    await user.keyboard('{Escape}')
    await waitForMenuToClose()
    expect(trigger).toHaveFocus()
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})

describe('MenuLinkItem', () => {
  test('a link closes the menu when chosen, and clicks in the menu never reach the component that owns it', async () => {
    const user = userEvent.setup()
    const onOwnerClick = mock()
    const onOwnerContextMenu = mock()
    render(
      // Stands in for a clickable owner, such as a tab.
      <div onClick={onOwnerClick} onContextMenu={onOwnerContextMenu}>
        <Menu>
          <MenuTrigger>Account</MenuTrigger>
          <MenuPopup aria-label="Account actions">
            <MenuLinkItem render={<a href="#settings" />}>Settings</MenuLinkItem>
          </MenuPopup>
        </Menu>
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'Account' }))
    await screen.findByRole('menu', { name: 'Account actions' })
    onOwnerClick.mockClear()

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('menuitem', { name: 'Settings' }) })
    expect(onOwnerContextMenu).not.toHaveBeenCalled()
    await user.click(screen.getByRole('menuitem', { name: 'Settings' }))
    await waitForMenuToClose()
    expect(onOwnerClick).not.toHaveBeenCalled()
  })
})

describe('ContextMenu', () => {
  test('a right click opens the menu, and choosing an item runs it and closes the menu', async () => {
    const user = userEvent.setup()
    const onRename = mock()
    render(
      <ContextMenu>
        <ContextMenuTrigger>Workspace one</ContextMenuTrigger>
        <ContextMenuPopup aria-label="Workspace actions">
          <MenuItem onClick={onRename}>Rename</MenuItem>
        </ContextMenuPopup>
      </ContextMenu>,
    )

    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Workspace one') })
    expect(await screen.findByRole('menu', { name: 'Workspace actions' })).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledTimes(1)
    await waitForMenuToClose()
  })
})

/** Base UI keeps a closing menu mounted until its exit animation ends. */
async function waitForMenuToClose() {
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
}
