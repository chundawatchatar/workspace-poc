import { describe, expect, test } from 'bun:test'
import { pgTable, text } from 'drizzle-orm/pg-core'
import * as schema from './schemas'
import { findUnscopedTables } from './scoped'
import { authLibraryTables, scopedTables } from './scoped-tables'

describe('findUnscopedTables', () => {
  test('every schema table with a userId is scoped or owned by Better Auth', () => {
    expect(findUnscopedTables(schema, scopedTables, authLibraryTables)).toEqual([])
  })

  test('reports a table with a userId and no repository, and ignores one without', () => {
    const owned = pgTable('owned', { id: text('id').primaryKey(), userId: text('user_id').notNull() })
    const shared = pgTable('shared', { id: text('id').primaryKey() })
    const registered = pgTable('registered', { id: text('id').primaryKey(), userId: text('user_id').notNull() })
    const exports = { ...schema, owned, shared, registered }
    expect(findUnscopedTables(exports, { ...scopedTables, registered }, authLibraryTables)).toEqual(['owned'])
  })
})
