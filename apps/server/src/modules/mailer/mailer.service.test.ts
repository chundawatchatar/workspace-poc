import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createMailer, MailSendError } from './mailer.service'
import { createCaptureTransport } from './mailer.testing'
import type { MailTransport } from './mailer.transport'

const from = 'Orch <no-reply@example.com>'
const to = 'a@example.com'
const token = 'abc123secret'
const url = `https://x.test/v?token=${token}`

function setup(transport?: MailTransport) {
  const capture = createCaptureTransport()
  return { ...capture, mailer: createMailer({ transport: transport ?? capture.transport, from }) }
}

/** Replaces every `console` method with one that records what it was given, and returns the records. */
function captureConsole(): string[] {
  const lines: string[] = []
  for (const key of Object.keys(console) as (keyof Console)[]) {
    if (typeof console[key] !== 'function') continue
    spyOn(console, key).mockImplementation(((...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(' '))
    }) as never)
  }
  return lines
}

afterEach(() => {
  mock.restore()
})

describe('createMailer', () => {
  test('sends each template once, with from, to, a subject and the link in both parts', async () => {
    const { mailer, sent, lastTo } = setup()
    captureConsole()
    await mailer.send(to, 'verifyEmail', { url })
    await mailer.send('b@example.com', 'resetPassword', { url })

    expect(sent).toHaveLength(2)
    for (const message of sent) {
      expect(message.from).toBe(from)
      expect(message.subject).not.toBe('')
      expect(message.text).toContain(url)
      expect(message.html).toContain(url)
    }
    expect(lastTo(to)?.subject).toBe(sent[0]?.subject)
    expect(lastTo('b@example.com')).toBe(sent[1])
    expect(sent[0]?.subject).not.toBe(sent[1]?.subject)
  })

  test('accepts only a known template with its own data', () => {
    const { mailer } = setup()
    // Never called: these lines exist for `bun run typecheck`.
    const _typeChecks = () => {
      // @ts-expect-error an unknown template name
      mailer.send(to, 'welcome', { url })
      // @ts-expect-error data without `url`
      mailer.send(to, 'verifyEmail', {})
    }
    expect(_typeChecks).toBeFunction()
  })

  test('escapes the link in the HTML part and keeps it verbatim in the text part', async () => {
    const { mailer, sent } = setup()
    captureConsole()
    const hostile = 'https://x.test/v?token="><script>alert(1)</script>'
    await mailer.send(to, 'verifyEmail', { url: hostile })

    const [message] = sent
    expect(message?.html).not.toContain('<script>')
    expect(message?.html).toContain('href="https://x.test/v?token=&quot;&gt;&lt;script&gt;')
    expect(message?.html).toContain('>https://x.test/v?token=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</a>')
    expect(message?.text).toContain(hostile)
  })

  test('logs neither the link, the token, the recipient nor the subject, whether a send works or fails', async () => {
    const lines = captureConsole()
    const { mailer, sent } = setup()
    await mailer.send(to, 'resetPassword', { url })
    const subject = sent[0]?.subject ?? ''

    const leaky: MailTransport = {
      send: async (message) => {
        throw Object.assign(new Error(`550 rejected ${message.to} ${message.subject} ${message.text}`), {
          code: 'EENVELOPE',
          response: message.html,
        })
      },
    }
    const failing = setup(leaky).mailer
    const failure = await failing.send(to, 'resetPassword', { url }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(MailSendError)
    expect((failure as MailSendError).code).toBe('EENVELOPE')
    expect((failure as MailSendError).message).not.toContain(url)
    expect((failure as MailSendError).message).not.toContain(token)
    expect(lines).toEqual(['mail resetPassword: sent', 'mail resetPassword: failed (EENVELOPE)'])
    const output = lines.join('\n')
    for (const secret of [url, token, to, subject]) expect(output).not.toContain(secret)
  })
})
