// The tables Better Auth owns (`user`, `session`, `account`, `verification`) come from its CLI and are split one table
// per file by hand. Keep their export names: Better Auth's Drizzle adapter looks tables up by name. To regenerate
// them after a Better Auth version bump or a new plugin, follow `packages/domain/README.md`.

export * from './account'
export * from './session'
export * from './user'
export * from './verification'
