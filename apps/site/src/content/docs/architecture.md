---
title: Architecture
description: How the host, the terminal daemon, the browser and the relay fit together.
group: Under the hood
order: 1
---

## The pieces

| Piece | What it does | Runs where |
| --- | --- | --- |
| **Web app** | The interface: sidebar, panes, terminals, palette | Your browser |
| **Host** | Owns the layout and git status, serves the API, opens the tunnel | Your machine, `127.0.0.1:4599` |
| **Terminal daemon** | Owns every pseudo-terminal, screen and shell | Your machine, over a Unix socket |
| **Relay** | Forwards remote traffic by machine id, stores nothing | Your server, or ours |
| **Global app** | Lists your linked machines and opens one through the relay | Any browser |

```text
browser ──ws──> host ── unix socket ──> terminal daemon ── PTY ──> $SHELL, agents
                  │
                  └── one outbound tunnel ──> relay <── any browser, with a connect link
```

## Why the shells outlive everything

The daemon is a separate process started by the host and left running. The host talks to it over a Unix socket, and reattaches after a restart or an update. The browser only ever sees a view of the screen, which is why closing it changes nothing.

## One interface, two apps

The page you see inside a machine is one shared package, used by both the local app and the global app. Only the transport differs: loopback for the local app, the relay for the global one. The two can't drift apart.

## Open source

Everything, including the relay and the global app, is open source under the MIT licence.
