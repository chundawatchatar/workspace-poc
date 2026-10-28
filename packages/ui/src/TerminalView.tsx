import { buildSocketUrl, routes, type TermClientMsg, type TermColors, type TermServerMsg } from '@orch/shared'
import type { ITheme, Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

interface Props {
  /** Opens a socket to the host for a path built by `buildSocketUrl`, such as `/ws/term/t1?cols=80`. */
  openSocket: (path: string) => WebSocket
  sessionId: string
  cwd: string
  /** True when this terminal is the visible tab of the focused pane. */
  active: boolean
  theme?: ITheme
}

const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

/** The theme's `#rrggbb` colours, leaving out any the theme doesn't set in that form. */
function themeColors(theme: ITheme | undefined): TermColors {
  const hex = (value: string | undefined) => (value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined)
  const ansi = ANSI.map((name) => hex(theme?.[name]))
  return {
    foreground: hex(theme?.foreground),
    background: hex(theme?.background),
    cursor: hex(theme?.cursor),
    ansi: ansi.every((value) => value !== undefined) ? ansi : undefined,
  }
}

/**
 * A view onto a session the host owns. Mounting attaches and receives a
 * snapshot of the screen; unmounting only detaches, and the shell keeps running.
 *
 * The host decides the session's size. This view reports the size its pane
 * can show and then displays whatever size the host says is in force, which
 * differs only while another, focused view of the same session is a different size.
 */
export function TerminalView({ openSocket, sessionId, cwd, active, theme }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const [ready, setReady] = useState(false)
  // Read when the terminal is created, without making the theme a reason to recreate it.
  const initialTheme = useRef(theme)
  initialTheme.current = theme
  // Tells the host the current theme's colours; set while a connection exists.
  const sendColors = useRef<(() => void) | null>(null)

  useEffect(() => {
    const element = container.current
    if (!element) return
    let disposed = false
    let cleanup = () => {}

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      if (disposed) return

      const term = new Terminal({
        fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: 5000,
        macOptionIsMeta: true,
        allowProposedApi: true,
        theme: initialTheme.current,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(element)
      fit.fit()

      let socket: WebSocket | null = null
      let retry: ReturnType<typeof setTimeout> | undefined
      let serverQueries = false
      let pendingBytes = 0
      let writes = Promise.resolve()

      // Only one view of a session answers queries; the host says which, and answers them itself while none is attached.
      const queryHandlers = [
        term.parser.registerCsiHandler({ final: 'n' }, () => serverQueries),
        term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, () => serverQueries),
        term.parser.registerCsiHandler({ final: 'c' }, () => serverQueries),
        term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => serverQueries),
        term.parser.registerCsiHandler({ prefix: '=', final: 'c' }, () => serverQueries),
        term.parser.registerCsiHandler({ final: 't' }, () => serverQueries),
        term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, () => serverQueries),
        term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => serverQueries),
        term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => serverQueries),
        ...[4, 10, 11, 12, 52].map((code) =>
          term.parser.registerOscHandler(code, (data) => serverQueries && data.split(';').includes('?')),
        ),
      ]

      const send = (message: TermClientMsg) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
      }
      sendColors.current = () => send({ type: 'colors', ...themeColors(initialTheme.current) })

      /** Tells the host what size this pane can show. */
      const report = () => {
        if (element.clientWidth === 0 || element.clientHeight === 0) return
        const size = fit.proposeDimensions()
        if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) {
          send({ type: 'resize', cols: size.cols, rows: size.rows })
        }
      }

      const adopt = (cols: number, rows: number) => {
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
      }

      const render = (
        ws: WebSocket,
        data: string | Uint8Array,
        snapshot?: Extract<TermServerMsg, { type: 'snapshot' }>,
      ) => {
        const bytes = typeof data === 'string' ? data.length * 2 : data.byteLength
        pendingBytes += bytes
        if (pendingBytes > 32 * 1024 * 1024) {
          pendingBytes -= bytes
          ws.close()
          return
        }
        writes = writes.then(
          () =>
            new Promise<void>((done) => {
              if (disposed || socket !== ws) {
                pendingBytes -= bytes
                done()
                return
              }
              if (snapshot) {
                serverQueries = snapshot.serverQueries ?? false
                term.reset()
                adopt(snapshot.cols, snapshot.rows)
              }
              term.write(data, () => {
                pendingBytes -= bytes
                if (snapshot) {
                  report()
                  if (document.hasFocus() && term.textarea === document.activeElement) send({ type: 'focus' })
                }
                done()
              })
            }),
        )
      }

      const connect = () => {
        const url = buildSocketUrl(routes.sockets.terminal, { id: sessionId, cwd, cols: term.cols, rows: term.rows })
        const ws = openSocket(url)
        ws.binaryType = 'arraybuffer'
        socket = ws
        ws.onopen = () => sendColors.current?.()
        ws.onmessage = (event) => {
          if (typeof event.data !== 'string') {
            render(ws, new Uint8Array(event.data as ArrayBuffer))
            return
          }
          const message = JSON.parse(event.data) as TermServerMsg
          if (message.type === 'snapshot') {
            render(ws, message.data, message)
          } else if (message.type === 'size') {
            writes = writes.then(() => {
              if (!disposed && socket === ws) adopt(message.cols, message.rows)
            })
          } else if (message.type === 'queries') {
            // Applied in order with the output, so a query already written is answered as it was decided.
            writes = writes.then(() => {
              if (!disposed && socket === ws) serverQueries = !message.answer
            })
          }
        }
        ws.onclose = () => {
          if (socket === ws) socket = null
          if (!disposed) retry = setTimeout(connect, 1000)
        }
      }
      connect()

      const onData = term.onData((data) => send({ type: 'input', data }))

      // Shift+Enter would arrive as a plain Enter and submit. It sends a line feed (Ctrl+J) instead, which
      // Claude Code, Codex and similar tools take as a new line in their input.
      // Cmd+K clears the screen as in macOS terminals. The host clears its copy too and sends the result back,
      // so the cleared output doesn't return on reload or stay in other views of the session.
      term.attachCustomKeyEventHandler((event) => {
        const newLine = event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
        const clear = event.code === 'KeyK' && event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey
        if (!newLine && !clear) return true
        if (event.type === 'keydown') send(newLine ? { type: 'input', data: '\n' } : { type: 'clear' })
        event.preventDefault()
        return false
      })

      // Focusing this view, including coming back to the window, puts it in control of the size.
      const onFocus = () => {
        report()
        send({ type: 'focus' })
      }
      term.textarea?.addEventListener('focus', onFocus)

      // At most one size report every 80 ms, plus a final one. An animated or
      // dragged resize then costs the shell a few redraws, not one per frame.
      let timer: ReturnType<typeof setTimeout> | undefined
      let lastReport = 0
      const observer = new ResizeObserver(() => {
        clearTimeout(timer)
        timer = setTimeout(
          () => {
            lastReport = performance.now()
            report()
          },
          Math.max(0, 80 - (performance.now() - lastReport)),
        )
      })
      observer.observe(element)

      terminal.current = term
      setReady(true)

      cleanup = () => {
        observer.disconnect()
        clearTimeout(timer)
        clearTimeout(retry)
        term.textarea?.removeEventListener('focus', onFocus)
        onData.dispose()
        for (const handler of queryHandlers) handler.dispose()
        sendColors.current = null
        socket?.close()
        term.dispose()
        terminal.current = null
      }
    })()

    return () => {
      disposed = true
      cleanup()
    }
  }, [openSocket, sessionId, cwd])

  useEffect(() => {
    if (ready && active) terminal.current?.focus()
  }, [ready, active])

  useEffect(() => {
    if (ready && terminal.current) terminal.current.options.theme = theme
    sendColors.current?.()
  }, [ready, theme])

  return <div ref={container} className="h-full w-full overflow-hidden bg-panel" />
}
