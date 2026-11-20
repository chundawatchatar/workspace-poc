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
| **Relay** | Relays remote traffic by machine id, stores no workspace content | The cloud server |
| **Global app** | Lists your linked machines and opens one through the relay | Any browser |

```text
browser ──ws──> host ── unix socket ──> terminal daemon ── PTY ──> $SHELL, agents
                  │
                  └── one outbound tunnel ──> relay <── any browser, signed in to your account
```

## Why the shells outlive everything

The daemon is a separate process started by the host and left running. The host talks to it over a Unix socket, and reattaches after a restart or an update. The browser only ever sees a view of the screen, which is why closing it changes nothing.

## Remote access

Remote access always needs an **account**. Connect links and access keys are gone: a machine joins your account when you accept it in the client, and only browsers signed in to that account, and approved on the machine itself, can open it. See [Remote access](/docs/remote-access).

- **Machine identity.** Each machine has its own key pair, and its id is a hash of the machine's public key. The private key never leaves the machine.
- **The server** keeps your account, its sign-in sessions and your machines' ids and names. It lists the account's sessions in the client's settings, where you can revoke any of them. It relays sealed traffic between your browsers and your machines, and stores no workspace content.
- **The remote access audit log**, of who opened the machine through the tunnel and who was refused, stays on each machine, in its data folder.

## One interface, two apps

The page you see inside a machine is one shared package, used by both the local app and the global app. Only the transport differs: loopback for the local app, the relay for the global one. The two can't drift apart.

## Open source

Everything, including the relay and the global app, is open source under the MIT licence.
