---
title: Remote access
description: Reach this machine's workspaces and terminals from any browser, through one outbound tunnel.
group: Remote
order: 1
---

## How it works

With remote access on, the host keeps **one outbound tunnel** open to a relay server. A browser anywhere opens a **connect link**, and the relay forwards its requests and terminal traffic through the tunnel to your machine. Your machine accepts no incoming connections, so there are no ports to open and no VPN to set up.

You can [run the relay yourself](/docs/self-hosting-the-relay) for free, or use the hosted relay that comes with an Orchestrator subscription.

## Turning it on

1. In the local app, open the command palette and choose **Remote access…**
2. Enter the relay's address: `wss://<server>`, or `ws://127.0.0.1:4600` for a relay on the same machine. Optionally enter the client address too.
3. Turn it on. The dialog shows whether the tunnel is connected.

The setting is saved, so the host reconnects on its own every time it starts. Turning it off closes the tunnel and every remote session at once.

## The connect link

The first time remote access is on, the host creates an **access key** and shows a connect link, once:

```text
https://<client>/#machine=<id>&key=<key>
```

Open it in any browser to reach the machine. The browser saves the machine, so later visits list it directly.

- The key sits after the `#`, which browsers never send to a server. Requests carry it in a header, sockets in their first message.
- The host keeps **only the key's hash**.
- Lost the link, or want to cut everyone off? Press **New connect link** in the dialog. The old key stops working and every remote session that used it is closed.

## Machine identity

The machine's id is derived from a random secret the host creates on first start. Keep it: deleting it gives the machine a new id, and old connect links stop working.
