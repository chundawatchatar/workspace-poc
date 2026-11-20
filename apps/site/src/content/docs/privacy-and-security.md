---
title: Privacy and security
description: What stays on your machine, what the relay can see, and what Orchestrator protects against today.
group: Under the hood
order: 2
---

## Your code stays on your machine

Shells, files, the layout and terminal output live on your machine or VM. Nothing about your code, terminals or issues is sent anywhere unless you choose, for example by running a cloud-based agent in a pane.

## The local service

- The host and web app bind to the **loopback address** only, so nothing else on your network can reach them.
- The host rejects requests from web pages on other origins.
- Other programs running on the same machine can use it. Signing in to the local service is planned before it can be exposed beyond the machine.

## Remote access

Remote access is a development setup for now, and it always goes through an account.

- The host connects **outwards**; it accepts no incoming connections. The tunnel runs only while the machine is connected to an account.
- A machine joins an account only when you accept it in the client, after checking its Machine key fingerprint.
- Every browser must be **approved on the machine**, by typing the fingerprint it shows. Revoking one there, or disconnecting the machine, closes what it has open.
- Sessions are **encrypted end to end** between your browser and the machine. The server relays them but can't read or change them. It still sees timing, sizes and which browser connects, and it can cut connections; a compromised server could also serve its own page in place of the client.
- The server rate-limits connections per IP and per machine, and refuses an IP for a while after too many refused requests.

## What the server stores

The server keeps your **account**, its **sign-in sessions**, your **machines' ids and names**, and the one-time keys you create to connect a machine, each used once and valid for 15 minutes. It never holds workspace content: no code, files, terminal output or layout.

The remote access audit log, which records who opened the machine through the tunnel and who was refused, is kept **on each machine**, in `remote-audit.jsonl` in the host's data folder, not on the server.

## Reporting a vulnerability

Please report security issues privately through the repository's security advisories rather than in public issues.
