import { type MailTemplate, renderCodeEmail } from './template'

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
      intro: 'Enter this code to finish creating your account. It works once and expires in 5 minutes.',
      code,
      outro: 'If you did not try to sign up, you can ignore this email; no account is created without the code.',
    }),
}
