# Requirements

What we expect from the product. Status: **Done** means the prototype does it today; **Partly** means it is done with the limits noted; **Next** is the next thing to build; **Later** is planned but not yet scheduled.

## The product

A free developer workspace that runs on the user's own machine or VM and is used entirely in the browser. It gives the user workspaces, split panes, tabs and real terminals, with coding agents such as Claude Code and Codex running inside them. Later it adds local git hosting, issues, automated workflows and agents that start on events, so code never has to leave the user's machine. A separate paid service, Orchestrator, lets users reach their own instances from anywhere.

## Principles

- **Local first.** Everything runs on the user's machine or VM. Code, issues and terminal output stay there.
- **Browser only.** No desktop app to install. The same interface works locally and, later, remotely.
- **Free locally.** Every feature that runs on the user's machine is free. Only remote access is paid.
- **Bring your own agent.** The product builds no agent of its own. Users run any command-line agent; the product shows what it is doing and, later, starts it on events.
- **Sessions outlive the browser.** Closing a tab or the browser never ends a shell or an agent. Restarting the host does end them today (see TERM-8).
- **Keyboard first.** Every action has a shortcut, and no shortcut fights the browser or the shell, apart from the `Ctrl+B` leader key (see KEY-5).

## Workspaces and layout

| ID | Requirement | Status |
| --- | --- | --- |
| WS-1 | A sidebar lists workspaces. Each is a folder on the host, with its git branch and number of changed files. Users can create, rename and close workspaces. | Done |
| WS-2 | Each workspace has its own address, so it can be bookmarked or opened in another window. | Done |
| WS-3 | Panes split right or down to any depth, and dividers drag to resize. | Done |
| WS-4 | Each pane holds several tabs. Tabs can be reordered by dragging, or dragged into another pane. | Done |
| WS-5 | The layout is saved and shared: reloading restores it, and every open window shows the same layout. | Done |
| WS-6 | Any pane can go full screen, filling the window with a clear frame so the user knows. Esc still goes to the terminal. | Done |
| WS-7 | The sidebar can be resized, remembers its width, and can be hidden and shown. | Done |

## Terminals

| ID | Requirement | Status |
| --- | --- | --- |
| TERM-1 | Each terminal tab is a real shell on the host, using the user's own shell configuration. | Done |
| TERM-2 | Reloading the page or switching workspace does not end a shell; coming back shows the screen as it was. | Done |
| TERM-3 | Full-screen programs such as vim, Claude Code and Codex fill the pane and follow it when it resizes. | Done |
| TERM-4 | With one terminal open in several windows, it takes the size of the window being used, and the other windows do not shrink it. | Done |
| TERM-5 | A shell that exits can be restarted in the same tab with Enter. | Done |
| TERM-6 | Tabs are named after what the shell reports, shortened to the current folder. | Done |
| TERM-7 | Shells started by the product do not inherit settings from the terminal or agent session the product was launched from. | Done |
| TERM-8 | Shells and agents survive a restart of the host. | Later |

## Notifications

| ID | Requirement | Status |
| --- | --- | --- |
| NOTE-1 | When a terminal rings the bell or sends a notification while the user is looking elsewhere, the pane gets a highlighted ring, the tab a dot, and the workspace a count and message in the sidebar. | Done |
| NOTE-2 | A list of everything waiting for attention, from which the user can jump straight to the terminal. | Done |
| NOTE-3 | Looking at the terminal clears its notification. | Done |

## Coding agents

| ID | Requirement | Status |
| --- | --- | --- |
| AG-1 | For Claude Code and Codex, each tab shows whether the agent is working, waiting for the user, or idle. | Next |
| AG-2 | The sidebar shows, per workspace, how many agents are in each state. | Next |
| AG-3 | The user is notified when an agent finishes, asks a question, or needs permission. | Next |
| AG-4 | Agent tracking works without editing the user's own agent settings. Where an agent asks the user to trust the tracking, the product asks once and never bypasses that check. | Next |
| AG-5 | Tracking can be turned off for a single session. | Next |
| AG-6 | Events such as a pull request opening, an issue being assigned or a check failing can start the user's chosen agent in a new pane, where the user can watch or take over. | Later |
| AG-7 | Agents started by events act only with access limited to their repository, and need the user's approval to merge or to use secrets. | Later |

## Keyboard and navigation

| ID | Requirement | Status |
| --- | --- | --- |
| KEY-1 | Every command has a shortcut that works in all major browsers, avoiding keys the browser keeps for itself (such as Ctrl/Cmd+W, T and N). | Done |
| KEY-2 | Common cmux shortcuts work on macOS: `Cmd+D` to split, `Cmd+B` for the sidebar, `Cmd+P` for the palette. | Done |
| KEY-3 | A command palette searches workspaces, open tabs and commands. | Done |
| KEY-4 | The full list of shortcuts is available in the app. | Done |
| KEY-5 | Shell keys such as `Ctrl+C`, `Ctrl+P` and `Ctrl+R` always reach the terminal. The exception is `Ctrl+B`, which the product uses as its leader key, so readline, vim and tmux inside a terminal receive it only when it is pressed twice (KEY-6). | Done |
| KEY-6 | Pressing the leader key twice (`Ctrl+B Ctrl+B`) sends `Ctrl+B` to the terminal, as in tmux. | Done |

## Look and feel

| ID | Requirement | Status |
| --- | --- | --- |
| UI-1 | Light and dark appearance, following the system by default, with a quick switch between them. | Done |
| UI-2 | A choice of themes, each covering both the interface and the terminal colours, with one remembered for light and one for dark. | Done |
| UI-3 | No flash of the wrong colours or sidebar width when the page loads. | Done |
| UI-4 | Layout changes, dialogs and the sidebar animate smoothly, and all motion stops when the system asks for reduced motion. | Done |
| UI-5 | The interface is built from a shared component package, used by both the local product and Orchestrator, so the two look and behave the same. | Next |

## Git, issues and workflows

| ID | Requirement | Status |
| --- | --- | --- |
| GIT-1 | Host git repositories locally; standard git clients can push and pull. | Later |
| GIT-2 | Pull requests with diffs, inline review comments, approvals and merge. | Later |
| GIT-3 | Issues with a board view, linked to branches and pull requests. | Later |
| GIT-4 | Workflows written in GitHub Actions syntax run on the host, triggered by pushes, pull requests, issues and schedules. | Later |
| GIT-5 | Optionally mirror a repository to or from an external host such as GitHub. Off by default. | Later |

The Pull requests and Issues tabs in the prototype show sample data only.

## Remote access (Orchestrator, paid)

| ID | Requirement | Status |
| --- | --- | --- |
| REM-1 | Users link their instances to an account and open any workspace, including its terminals, from any browser. | Later |
| REM-2 | Traffic is encrypted end to end; the service relays it but cannot read it, and stores no workspace content. | Later |
| REM-3 | Instances connect outwards, so no ports need opening on the user's network. | Later |
| REM-4 | A dashboard shows every linked instance and whether it is online. | Later |
| REM-5 | Devices must be approved, and access can be revoked at any time. | Later |
| REM-6 | Cancelling the subscription removes remote access only; local work is never affected. | Later |

## Platforms, privacy and security

| ID | Requirement | Status |
| --- | --- | --- |
| PLAT-1 | Runs on macOS and Linux. | Done |
| PLAT-2 | Runs on Windows. | Later |
| PLAT-3 | Works in current Chrome, Edge, Safari and Firefox. Checked in Chrome only so far. | Partly |
| SEC-1 | The local service is reachable only from the same machine, and web pages from other sites cannot use it. Other programs running on the same machine can use it. | Done |
| SEC-2 | Signing in to the local service before it can be exposed beyond the machine. | Later |
| SEC-3 | Nothing about the user's code, terminals or issues is sent anywhere unless the user chooses to, for example by using a cloud-based agent. | Done |

## Open questions

- The product's name, and whether "Orchestrator" stays as the name of the paid service.
- Which licence the local product uses. Decided: the local product is open source and Orchestrator is closed source.
- How Windows is supported.
- Orchestrator plans and prices.
