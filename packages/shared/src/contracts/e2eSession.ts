import { z } from 'zod'
import { defineContract } from './contract'
import { e2eBrowserHello, e2eMachineHello } from './e2e'

/** An end-to-end session's id: 128 random bits as unpadded base64url. */
export const e2eSessionId = z.string().regex(/^[A-Za-z0-9_-]{22}$/)

/** The machine's answer to a browser hello: the session it keeps, its signed hello and when the session expires. */
export const openE2eSessionResponse = z.strictObject({
  sessionId: e2eSessionId,
  hello: e2eMachineHello,
  /** When the machine forgets the session, as an ISO date. The browser opens a new one before then. */
  expiresAt: z.iso.datetime(),
})
export type OpenE2eSessionResponse = z.infer<typeof openE2eSessionResponse>

export const e2eContract = defineContract({
  open: {
    method: 'POST',
    path: '/api/e2e/sessions',
    description:
      "Opens an end-to-end session for an approved browser's signed hello, answered signed with the machine key. Works only through the tunnel.",
    input: e2eBrowserHello,
    output: openE2eSessionResponse,
  },
})
