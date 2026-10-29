import type { MailMessage, MailTransport } from './mailer.transport'

/** A transport for tests that keeps every message instead of sending it. */
export interface CaptureTransport {
  transport: MailTransport
  /** Every message sent, oldest first. */
  sent: MailMessage[]
  /** The last message sent to `address`, or undefined when none was. */
  lastTo(address: string): MailMessage | undefined
}

/** Creates a capturing transport, so tests can read emails and their links without a network. Only tests import it. */
export function createCaptureTransport(): CaptureTransport {
  const sent: MailMessage[] = []
  return {
    transport: {
      async send(message) {
        sent.push(message)
      },
    },
    sent,
    lastTo(address) {
      for (let index = sent.length - 1; index >= 0; index--) {
        if (sent[index]?.to === address) return sent[index]
      }
      return undefined
    },
  }
}
