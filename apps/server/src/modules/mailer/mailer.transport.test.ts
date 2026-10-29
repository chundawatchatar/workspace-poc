import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { createSmtpTransport } from './mailer.transport'

let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

/**
 * Starts a minimal SMTP server on a random local port that accepts any
 * message, and resolves the raw `DATA` of each one through `received`.
 */
async function fakeSmtp() {
  const received: string[] = []
  server = createServer((socket) => {
    let buffer = ''
    let inData = false
    socket.write('220 fake ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          received.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 5)
          inData = false
          socket.write('250 queued\r\n')
          continue
        }
        const lineEnd = buffer.indexOf('\r\n')
        if (lineEnd < 0) return
        const command = buffer.slice(0, lineEnd).toUpperCase()
        buffer = buffer.slice(lineEnd + 2)
        if (command.startsWith('DATA')) {
          inData = true
          socket.write('354 go ahead\r\n')
        } else if (command.startsWith('QUIT')) {
          socket.end('221 bye\r\n')
        } else {
          socket.write('250 ok\r\n')
        }
      }
    })
  })
  const { port } = await new Promise<{ port: number }>((resolve) => {
    server?.listen(0, '127.0.0.1', () => resolve(server?.address() as { port: number }))
  })
  return { port, received }
}

describe('createSmtpTransport', () => {
  test('sends a multipart/alternative message with a text part, an HTML part and the given From', async () => {
    const { port, received } = await fakeSmtp()
    const transport = createSmtpTransport(`smtp://127.0.0.1:${port}`)

    await transport.send({
      from: 'Orch <no-reply@example.com>',
      to: 'a@example.com',
      subject: 'Verify your email address',
      text: 'plain body',
      html: '<p>html body</p>',
    })

    expect(received).toHaveLength(1)
    const raw = received[0] ?? ''
    expect(raw).toMatch(/^From: Orch <no-reply@example\.com>$/m)
    expect(raw).toMatch(/^Content-Type: multipart\/alternative;/m)
    expect(raw).toMatch(/^Content-Type: text\/plain/m)
    expect(raw).toMatch(/^Content-Type: text\/html/m)
  })

  test('fails a send to a server that never greets, after the greeting timeout', async () => {
    server = createServer(() => {})
    const { port } = await new Promise<{ port: number }>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve(server?.address() as { port: number }))
    })
    const transport = createSmtpTransport(`smtp://127.0.0.1:${port}`, {
      connectionMs: 1000,
      greetingMs: 100,
      socketMs: 1000,
    })
    const message = { from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't', html: 'h' }
    const error = await transport.send(message).catch((caught: unknown) => caught)
    expect((error as { code?: string }).code).toBe('ETIMEDOUT')
  })
})
