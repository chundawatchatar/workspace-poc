import { createColumnHelper, type RowData, tableFeatures, useTable } from '@tanstack/react-table'
import { type ReactNode, useId, useMemo } from 'react'

/** One column of a `DataTable`. */
export interface DataTableColumn<Row> {
  id: string
  header: string
  /** Keeps the header for screen readers only, such as over a column of buttons. */
  hideHeader?: boolean
  cell: (row: Row) => ReactNode
  align?: 'start' | 'end'
  /** A note shown under the table that describes this column's header, for a caveat too long for the header. */
  note?: string
}

// TanStack Table wants its features stable across renders.
const features = tableFeatures({})

/**
 * A bordered table of rows, one cell per column. Pass `columns` as a stable value (defined outside the component
 * or memoized): a new array rebuilds the table on every render.
 */
export function DataTable<Row extends RowData>({
  rows,
  columns,
  getRowId,
}: {
  rows: Row[]
  columns: DataTableColumn<Row>[]
  getRowId: (row: Row) => string
}) {
  const noteId = useId()
  const noteIdFor = (column: DataTableColumn<Row>) => (column.note ? `${noteId}-${column.id}` : undefined)

  const tableColumns = useMemo(() => {
    const helper = createColumnHelper<typeof features, Row>()
    return helper.columns(
      columns.map((column) =>
        helper.display({
          id: column.id,
          header: () => (column.hideHeader ? <span className="sr-only">{column.header}</span> : column.header),
          cell: ({ row }) => column.cell(row.original),
        }),
      ),
    )
  }, [columns])
  const byId = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns])
  const table = useTable({ features, columns: tableColumns, data: rows, getRowId })

  return (
    <>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-left text-[13px]">
          <thead className="text-xs text-faint">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b border-line">
                {group.headers.map((header) => {
                  const column = byId.get(header.column.id)
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-describedby={column && noteIdFor(column)}
                      className="px-3 py-2 font-medium whitespace-nowrap"
                    >
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-line">
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={`px-3 py-2 align-top text-ink ${byId.get(cell.column.id)?.align === 'end' ? 'text-right' : ''}`}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {columns.map(
        (column) =>
          column.note && (
            <p key={column.id} id={noteIdFor(column)} className="text-xs text-faint">
              {column.note}
            </p>
          ),
      )}
    </>
  )
}
