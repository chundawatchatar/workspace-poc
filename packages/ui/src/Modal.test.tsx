import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Modal } from './Modal'

function Opener(props: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  const close = () => {
    props.onClose?.()
    setOpen(false)
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Modal title="Rename" onClose={close}>
          <input aria-label="Name" />
          <button type="button">Save</button>
        </Modal>
      )}
    </>
  )
}

describe('Modal', () => {
  test('is named by its title, keeps Tab inside, and gives focus back to the opener on Escape', async () => {
    const user = userEvent.setup()
    const onClose = mock()
    render(<Opener onClose={onClose} />)
    const opener = screen.getByRole('button', { name: 'Open' })

    await user.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Rename' })
    expect(dialog).toContainElement(document.activeElement as HTMLElement)

    for (let i = 0; i < 4; i++) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })
})
