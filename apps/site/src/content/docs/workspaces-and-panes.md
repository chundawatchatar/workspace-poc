---
title: Workspaces and panes
description: Organise work into workspaces, split them into panes, and give each pane as many tabs as you need.
group: Use
order: 1
---

## Workspaces

A workspace is a folder on the host, listed in the sidebar with its **git branch** and **number of changed files**. Create, rename (double-click the name) and close workspaces from the sidebar.

Every workspace has its own address, so you can bookmark it or open it in another window. `Ctrl+B` then `1`–`9` jumps straight to one.

## Splits

Panes split right (`Ctrl+B D`) or down (`Ctrl+B E`) to any depth. Drag a divider to resize the panes on each side of it. Move focus between panes with `Ctrl+B` and an arrow key, or `Ctrl+B O` for the next one.

## Tabs

Each pane holds several tabs. `Ctrl+B C` opens a new terminal tab, `Ctrl+B X` closes one, and `Ctrl+B N` / `P` move between them.

Tabs can be dragged:

- within a tab bar, to reorder them;
- onto another pane's tab bar, to place them there;
- onto another pane's body, to add them at the end.

## Full screen

Any pane can fill the window with `Ctrl+B Z` (or `Ctrl+Shift+F`). A violet frame shows that it is in full screen. `Esc` still goes to the terminal, so leave full screen with the same key.

## One layout, every window

The host stores the layout and pushes every change to every open window. Two browser windows on the same workspace always show the same splits and tabs, and reloading the page restores them exactly.

## The sidebar

Drag the sidebar's right edge to resize it (double-click to reset). `⌘B` on a Mac, or `Ctrl+B B` anywhere, hides and shows it.
