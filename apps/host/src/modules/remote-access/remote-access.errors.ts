import type { ConnectOutcomeKind } from '@orch/shared'

// What remote access refuses, as errors whose messages are meant for the user.

/** A setting the host refuses, such as a server address `parseServerUrl` rejects. Its message is meant for the user. */
export class InvalidRemoteAccessSetting extends Error {}

/**
 * A typed fingerprint that matches no waiting or approved device, whether it is
 * unknown, expired or malformed. Its message is meant for the user and echoes
 * what they typed, which is not secret.
 */
export class UnknownDevice extends Error {
  constructor(typed: string) {
    super(
      `No browser with the fingerprint ${typed.trim()} is waiting. Open this machine in your own browser and type the fingerprint it shows.`,
    )
  }
}

/** A typed fingerprint that more than one device shares, so none was approved. Its message is meant for the user. */
export class AmbiguousDevice extends Error {
  constructor(typed: string) {
    super(
      `More than one browser has the fingerprint ${typed.trim()}, so none was approved. Dismiss the ones you don't recognise, then try again.`,
    )
  }
}

/**
 * Why connecting to an account failed, with the HTTP status to answer. Its
 * message is meant for the user and never holds the key or the email.
 */
export class ConnectError extends Error {
  constructor(
    readonly status: 400 | 409 | 429 | 502 | 503,
    message: string,
  ) {
    super(message)
  }
}

/** The status and message each `enroll.failed` code answers Connect with. None holds the key or the email. */
export const ENROLL_FAILURES = {
  invalid_key: [400, "This key is unknown, used or expired, or the email doesn't match the account that created it"],
  rate_limited: [429, 'Too many tries. Wait a minute, then try again'],
  unavailable: [503, 'The server could not check the key. Try again later'],
  rejected: [409, 'The connect request was rejected in the client. Nothing was linked'],
} as const

/** What the status says when a Connect that waited ends unlinked. None holds the key or the email. */
export const OUTCOME_MESSAGES: Record<ConnectOutcomeKind, string> = {
  rejected: ENROLL_FAILURES.rejected[1],
  expired:
    'The key expired before the connect request was accepted. Nothing was linked. Create a new key in the client',
  cancelled: 'The connect request was cancelled. Nothing was linked',
  failed: 'The connection to the server ended before the connect request was answered. Nothing was linked',
}
