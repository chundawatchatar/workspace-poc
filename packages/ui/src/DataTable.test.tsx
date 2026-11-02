import { describe, expect, test } from 'bun:test'
import { render, screen, within } from '@testing-library/react'
import { DataTable, type DataTableColumn } from './DataTable'

type Row = { id: string; name: string }

const columns: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', note: 'Names are case-sensitive.', cell: (row) => row.name },
  {
    id: 'action',
    header: 'Action',
    hideHeader: true,
    align: 'end',
    cell: (row) => <button type="button">Edit {row.name}</button>,
  },
]

describe('DataTable', () => {
  test('renders a row per item, and a column note describes its header', () => {
    render(
      <DataTable
        rows={[
          { id: 'a', name: 'Ada' },
          { id: 'b', name: 'Bo' },
        ]}
        columns={columns}
        getRowId={(row) => row.id}
      />,
    )
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAccessibleDescription('Names are case-sensitive.')
    expect(screen.getByRole('columnheader', { name: 'Action' })).toBeInTheDocument()
    const [, first, second] = screen.getAllByRole('row')
    expect(within(first as HTMLElement).getByRole('cell', { name: 'Ada' })).toBeInTheDocument()
    expect(within(second as HTMLElement).getByRole('button', { name: 'Edit Bo' })).toBeInTheDocument()
  })
})
