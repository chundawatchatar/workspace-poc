---
name: comment
description: House style for code comments in this repo — when to write one, the doc-comment vs line-comment split, and wording. Use when adding or reviewing comments in TypeScript/TSX, or when asked to document or comment code.
---

Comments here are sparse, plain English prose. Match this style exactly.

## When to comment

- Exported functions, types, interface fields and non-obvious state get a doc comment saying what they are or do.
- Inside a function, comment only to explain *why*: a constraint, a browser quirk, an ordering requirement, a deliberate trade-off. Never narrate what the next line does.
- No `TODO`/`FIXME`. If something is deliberately incomplete or misplaced, say where it belongs and what moving it costs. For example: "It belongs there as an optional index on `surface.move`; moving it means restarting the host, which ends its shells."
- No commented-out code, no section banners, no changelog notes ("added X", "fixed Y").

## Form

- `/** … */` for doc comments on declarations. Keep them on one line when they fit in 120 columns. Otherwise use the multi-line form, with ` * ` prefixes and the text wrapped near 80 columns.
- `//` for comments inside function bodies, on the line above the code they explain. A comment that runs over two lines wraps onto a second `//` line.
- No JSDoc tags (`@param`, `@returns`, `@example`). Describe parameters in the sentence: "With `toIndex` it lands at that position; without it, the tab goes to the end."
- Wrap identifiers, values and paths in backticks: `sync: false`, `surface.move`.

## Wording

- Full sentences, starting with a capital and ending with a full stop.
- Doc comments on functions use a present-tense verb in the third person: "Moves a tab to a pane.", "Reads the saved choices…". On values and fields, use a noun phrase: "The shared layout, owned by the host.", "Secondary text, also searched."
- Booleans: "True when …" / "True between … and …". Nullables: say what null means ("null means no match").
- British spelling (colour, behaviour), as in the existing code.
- Describe what the user sees or what the system guarantees, not the implementation mechanics: "Looking at a terminal counts as having seen its notification."
- Be brief. Cut "This function", "basically", "simply", "Note that".

## Examples from this codebase

```ts
/** Sessions in a workspace that are waiting to be looked at, newest first. */
export function pendingAttention(workspace: Workspace, sessions: Record<string, SessionInfo>) {

/** Lower is better; null means no match. Whole-word and prefix matches beat scattered letters. */

// The tab being dragged. Browsers hide drag data until the drop, so the pane
// under the pointer reads this to know where the tab came from.

// Close first: some commands open another dialog.
```

When reviewing, flag comments that restate the code, drift from what the code now does, or break the rules above, and propose a replacement.
