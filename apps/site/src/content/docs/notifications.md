---
title: Notifications
description: Know the moment a terminal needs you, without watching it.
group: Use
order: 3
---

## How it looks

When a terminal rings the bell or sends a notification while you are looking elsewhere:

- the **pane** gets a glowing ring;
- its **tab** gets a dot;
- its **workspace** in the sidebar gets a count and the latest message.

Looking at the terminal clears all three.

## What triggers it

Anything a program writes to the terminal:

- the bell character, `\a`;
- the OSC 9 notification sequence, `ESC ] 9 ; <message> BEL`, whose message appears in the sidebar.

Try it from a pane you then click away from:

```sh
sleep 3; printf '\e]9;Build finished\a'
```

Most coding agents can be set to ring the bell when they finish or need permission. That's all Orchestrator needs.

## Everything waiting for you

The **Notifications** button lists everything waiting for you, with each message. Pick one to jump straight to its terminal.
