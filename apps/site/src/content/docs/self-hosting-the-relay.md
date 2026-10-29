---
title: Self-hosting the relay
description: Run the relay server on your own infrastructure, free, under the same MIT licence.
group: Remote
order: 2
---

## What the relay does

The relay (`apps/server`) forwards traffic between browsers and machines by machine id. It never decides access on its own: every request still has to carry a key the machine accepts. It also serves the global app that connect links open, so links work on the relay's own origin without CORS.

## Build and start

```sh
bun run --filter @orch/client build
bun run --filter @orch/server start
```

The server listens on `127.0.0.1:4600` and serves the built client from `apps/client/dist` (or `SERVER_STATIC_DIR`). Without a build it only relays. Put it behind your usual TLS proxy and point machines at `wss://<your-domain>`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `SERVER_STATIC_DIR` | Where to serve the global app from, instead of `apps/client/dist` |
| `SERVER_ALLOWED_ORIGINS` | Comma-separated origins allowed to make cross-origin calls |
| `SERVER_TRUST_PROXY=1` | Behind a proxy that sets `X-Forwarded-For`, so rate limits see the client's IP |

## Built-in protection

The relay rate-limits connections per IP and per machine, and blocks an IP for a while after too many rejected keys.

## On the machine

The host's `SERVER_URL` and `CLIENT_URL` environment variables override the saved addresses. `SERVER_URL` also turns the tunnel on at start, whatever the saved setting says.
