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

The server listens on `SERVER_HOST`:`SERVER_PORT` (`127.0.0.1:4600` in `.env.example`) and serves the built client from `SERVER_STATIC_DIR`. Without a build it only relays. Put it behind your usual TLS proxy and point machines at `wss://<your-domain>`.

## Configuration

Every setting lives in the root `.env`; copy `.env.example` to start. Nothing has a default in code, so the server stops at start-up and names any required variable that is missing.

| Variable | Purpose |
| --- | --- |
| `SERVER_STATIC_DIR` | Required. Where to serve the global app from (`apps/client/dist` in `.env.example`). A relative path resolves from the repo root, whatever the working directory |
| `SERVER_MAX_CHANNELS` | Required. Most open channels (terminal sockets) per machine (`128` in `.env.example`) |
| `SERVER_REQUEST_TIMEOUT_MS` | Required. How long a relayed HTTP request waits for its machine, in milliseconds (`30000` in `.env.example`) |
| `SERVER_ALLOWED_ORIGINS` | Optional. Comma-separated origins allowed to make cross-origin calls |
| `SERVER_TRUST_PROXY=1` | Optional. Behind a proxy that sets `X-Forwarded-For`, so rate limits see the client's IP |

## Built-in protection

The relay rate-limits connections per IP and per machine, and blocks an IP for a while after too many rejected keys.

## On the machine

The host's `SERVER_URL` and `CLIENT_URL` environment variables override the saved addresses. `SERVER_URL` also turns the tunnel on at start, whatever the saved setting says.
