import { type MailTemplate, renderCodeEmail } from './template'

/** How long a sign-up code works. `createAuth` sets the code's `expiresIn` from it, so the email can't drift. */
export const SIGN_UP_CODE_MINUTES = 5

/** What the sign-up code email needs: the 6-digit code that proves the address and finishes the sign-up. */
export interface SignUpCodeData {
  code: string
}

/** Sent when someone asks for a sign-up code for an address that has no account. */
export const signUpCode: MailTemplate<'signUpCode', SignUpCodeData> = {
  name: 'signUpCode',
  render: ({ code }) =>
    renderCodeEmail({
      subject: 'Your sign-up code',
      intro: `Enter this code to finish creating your account. It works once and expires in ${SIGN_UP_CODE_MINUTES} minutes.`,
      code,
      outro: 'If you did not try to sign up, you can ignore this email; no account is created without the code.',
    }),
}
