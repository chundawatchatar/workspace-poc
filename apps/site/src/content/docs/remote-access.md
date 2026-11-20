---
title: Remote access
description: Connect this machine to your account and open its workspaces and terminals from any browser, through one outbound tunnel.
group: Remote
order: 1
---

Remote access is a development setup for now: it runs, but no hosted service is live yet.

## How it works

Remote access always goes through an **account**. You connect the machine to your account once, and from then on any browser signed in to that account can open it, terminals and all.

While the machine is connected, the host keeps **one outbound tunnel** open to the server, which relays each browser's requests and terminal traffic through it. Your machine accepts no incoming connections, so there are no ports to open and no VPN to set up.

## Connecting a machine

1. Sign in to the client and press **Connect a machine** on the home page. It creates a **one-time key**, valid for 15 minutes, and shows the command to run on the machine.
2. On the machine, either run that command:

   ```sh
   corch connect --email <email> --key <key> --server <url>
   ```

   or open the local app, pick **Remote access…** from the command palette, fill in the server address, your email and the key, and press **Connect**.
3. Before it sends anything, the machine shows what to check: the email, the server address, and the last 4 characters of the key, which the client shows too. Connect only to a server you trust.
4. The machine then waits for you and shows its **Machine key** fingerprint, such as `ABCD-EFGH-JKMN-PQRS`.
5. In the client, the request appears with the machine's name and its Machine key fingerprint. Check that it is the one the machine shows and press **Accept**. If it differs, press **Reject**: someone else may hold your key.

Once you accept, the machine's Remote access… dialog shows your account, its server and **Connected**, and the host reconnects on its own every time it starts. Rejecting, cancelling or letting the key run out links nothing.

In this repo, `bun run host:remote connect` takes the same flags as `corch connect`.

## Opening it from a browser

Every machine connected to your account is listed on the client's home page. Click its name to open it.

The first time a browser opens a machine, the page shows the machine's key fingerprint and asks you to compare it with the **Machine key** the machine shows in its Remote access… dialog. Answer **It matches** only after comparing: the browser then pins the key and checks it on every later visit. If the page ever says **The machine key doesn't match**, it stops and opens nothing. Don't use that browser for the machine until you know why.

## Approving browsers

A browser signed in to your account still needs your approval on the machine itself. Until then, its page shows the browser's own fingerprint and waits.

To approve it, type the fingerprint **your browser shows** into **Fingerprint shown in your browser** in the machine's Remote access setting and press **Approve**, or run this on the machine:

```sh
corch remote devices approve <fingerprint>
```

Always type it from your own browser, never from the machine's list of waiting browsers: a browser you don't know can put itself on that list. The page opens by itself once it is approved.

- **Revoke** an approved browser in the Remote access setting to take its access away and close what it has open.
- **Disconnect**, in the dialog or with `corch disconnect`, removes the machine from your account when the server can, forgets the account and its approved browsers, closes their sessions and stops the tunnel.

## Sealed sessions

Every request and terminal session is encrypted **end to end** between your browser and the machine. The server relays the sealed traffic but can't read it or inject into it, and the machine refuses traffic through the tunnel that isn't sealed.

What remains: the server still sees timing, sizes and which browser connects, it can cut connections, and a compromised server could serve its own page in place of the client. The machine's list of open sessions, its log of recent remote access and Disconnect are your cover for that.

## Machine identity

The machine keeps its own key pair in its data folder, and its id is the SHA-256 hash of the machine's public key. The Machine key fingerprint is taken from that id, which is how the client and the machine can show you the same one.

The private key never leaves the machine. Keep it: deleting it gives the machine a new id, so your account no longer lists it and every browser must check its new key again.
