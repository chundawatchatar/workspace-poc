import '@xterm/xterm/css/xterm.css'
import type { TermClientMsg, TermServerMsg } from '@poc/shared'
import type { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { getSnapshot, HOST_WS, useApp } from '../lib/store'
import { themeById } from '../lib/themes'

interface Props {
  sessionId: string
  cwd: string
  /** True when this terminal is the visible tab of the focused pane. */
  active: boolean
}

/**
 * A view onto a session the host owns. Mounting attaches and receives a
 * snapshot of the screen; unmounting only detaches, and the shell keeps running.
 *
 * The host decides the session's size. This view reports the size its pane
 * can show and then displays whatever size the host says is in force, which
 * differs only while another, focused view of the same session is a different size.
 */
export function TerminalView({ sessionId, cwd, active }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const [ready, setReady] = useState(false)
  const themeId = useApp((s) => s.themeId)

  useEffect(() => {
    const element = container.current
    if (!element) return
    let disposed = false
    let cleanup = () => {}

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      if (disposed) return

      const term = new Terminal({
        fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: 5000,
        macOptionIsMeta: true,
        allowProposedApi: true,
        theme: themeById(getSnapshot().themeId)?.terminal,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(element)
      fit.fit()

      let socket: WebSocket | null = null
      let retry: ReturnType<typeof setTimeout> | undefined

      const send = (message: TermClientMsg) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
      }

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

      const connect = () => {
        const query = new URLSearchParams({ cwd, cols: String(term.cols), rows: String(term.rows) })
        const ws = new WebSocket(`${HOST_WS}/ws/term/${sessionId}?${query}`)
        ws.binaryType = 'arraybuffer'
        socket = ws
        ws.onmessage = (event) => {
          if (typeof event.data !== 'string') {
            term.write(new Uint8Array(event.data as ArrayBuffer))
            return
          }
          const message = JSON.parse(event.data) as TermServerMsg
          if (message.type === 'snapshot') {
            // Match the session's size before drawing its screen, then ask for ours.
            term.reset()
            adopt(message.cols, message.rows)
            term.write(message.data)
            report()
            if (document.hasFocus() && term.textarea === document.activeElement) send({ type: 'focus' })
          } else if (message.type === 'size') {
            adopt(message.cols, message.rows)
          }
        }
        ws.onclose = () => {
          if (socket === ws) socket = null
          if (!disposed) retry = setTimeout(connect, 1000)
        }
      }
      connect()

      const onData = term.onData((data) => send({ type: 'input', data }))

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
        socket?.close()
        term.dispose()
        terminal.current = null
      }
    })()

    return () => {
      disposed = true
      cleanup()
    }
  }, [sessionId, cwd])

  useEffect(() => {
    if (ready && active) terminal.current?.focus()
  }, [ready, active])

  useEffect(() => {
    if (ready && terminal.current) terminal.current.options.theme = themeById(themeId)?.terminal
  }, [ready, themeId])

  return <div ref={container} className="h-full w-full overflow-hidden bg-panel" />
}
