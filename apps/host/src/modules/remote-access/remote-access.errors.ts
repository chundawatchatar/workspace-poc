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

/** Why linking with a key failed, with the HTTP status to answer. Its message is meant for the user and never holds the key. */
export class LinkError extends Error {
  constructor(
    readonly status: 400 | 409 | 429 | 502 | 503,
    message: string,
  ) {
    super(message)
  }
}
