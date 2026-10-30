import { machines } from './schemas/machines'
import type { ScopedTable } from './scoped'

/**
 * Every app-owned table with a `userId` column, by repository name.
 * `domain.forUser(principal)` gets one scoped repository per entry. Register a
 * new table here, or the coverage test in `scoped-tables.test.ts` fails.
 */
export const scopedTables = { machines } satisfies Record<string, ScopedTable>

/** The registered tables' type, which names the repositories `forUser` returns. */
export type ScopedTables = typeof scopedTables

/**
 * Better Auth's tables, exempt from scoping by export name. Only Better Auth
 * reads them, through `forAuthLibrary()`.
 */
export const authLibraryTables: readonly string[] = ['user', 'session', 'account', 'verification']
