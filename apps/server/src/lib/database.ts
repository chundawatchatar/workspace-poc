import { checkMigrations } from '@orch/domain'

type Db = Parameters<typeof checkMigrations>[0]

/** Where a database URL points, as `host:port`, without the user or password, so it is safe to print. */
export function databaseLocation(url: string): string {
  try {
    const { hostname, port } = new URL(url)
    return `${hostname}:${port || '5432'}`
  } catch {
    return 'an unparseable DATABASE_URL'
  }
}

/**
 * Checks that the accounts database answers and has every migration applied.
 * Returns null when it is ready, or the message to exit with. The message
 * shows `location` and an error code at most, never the URL or the error text,
 * which could hold the password.
 */
export async function checkDatabase(db: Db, location: string, timeoutMs = 10_000): Promise<string | null> {
  let pending: string[]
  try {
    // Its first query is the first use of the connection, so a failure here means the database can't be reached.
    pending = await withTimeout(checkMigrations(db), timeoutMs)
  } catch (error) {
    // Drizzle wraps the driver's error, which carries the code, in `cause`.
    const code = errorCode(error) ?? errorCode((error as { cause?: unknown } | null)?.cause)
    const reason = code ? ` (${code})` : ''
    return `The database at ${location} is unreachable${reason}. Start it with \`bun run db:up\`, or unset DATABASE_URL to run the relay alone.`
  }
  if (pending.length > 0) {
    return `The database at ${location} has ${pending.length} pending migration(s): ${pending.join(', ')}. Run \`bun run db:migrate\`, then start the server again.`
  }
  return null
}

/** A driver error code such as `ERR_POSTGRES_CONNECTION_REFUSED`, or undefined when there is none. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : undefined
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
