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

- The host connects **outwards**; it accepts no incoming connections.
- Every tunneled request and socket needs an **access key**. The host stores only its hash.
- Rotating the key closes every remote session that used the old one.
- The relay rate-limits connections and blocks IPs after repeated rejected keys.
- The relay forwards traffic but stores no workspace content. Today traffic is protected by TLS between each side and the relay; **end-to-end encryption**, so the relay cannot read it at all, is planned.

## Reporting a vulnerability

Please report security issues privately through the repository's security advisories rather than in public issues.
