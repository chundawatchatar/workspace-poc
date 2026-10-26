---
name: factory
description: Run the software factory. Takes a feature through spec, build, four parallel reviews and approval, then merges it to main. Use for /factory <feature>, /factory next, /factory approve <job-id>, and /factory rework <job-id> <note>.
---

The session that runs this skill is the **orchestrator**. It runs the loop below, spawns every agent, and is the only
writer of `factory/board.json`. Agents get their context from files, never from this conversation, and each one
writes only its own file.

## The loop (edit this to change the factory)

```
                   ┌──────────────────┐
                   │     feature      │
                   └─────────┬────────┘
                             ▼
                   ┌──────────────────┐
                   │   spec-writer    │
                   │       opus       │
                   └─────────┬────────┘
                             ▼
                   ┌──────────────────┐
                   │     builder      │◄────────────────────┐
                   │       opus       │                     │
                   └─────────┬────────┘                     │
        ┌─────────────┬──────┴──────┬─────────────┐         │
        ▼             ▼             ▼             ▼         │
  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐   │
  │  security │ │     ux    │ │ ui design │ │    code   │   │
  │    opus   │ │   sonnet  │ │   sonnet  │ │   sonnet  │   │
  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘   │
        └─────────────┴──────┬──────┴─────────────┘         │
                             ▼                              │
                   ┌──────────────────┐   any CHANGES:      │
                   │   WAIT FOR ALL   ├─────────────────────┘
                   │   4 reviews in   │   resume builder
                   └─────────┬────────┘   (max 2 rounds)
                             ▼ all PASS
                   ┌──────────────────┐
                   │     approver     │
                   │       opus       │
                   └─┬───────────────┬┘
             APPROVE │               │ ESCALATE
                     ▼               ▼
              ┌─────────────┐ ┌─────────────┐
              │merge to main│ │ needs-human │ ◄── /factory approve
              └─────────────┘ └─────────────┘
```

The agent models come from each agent file's `model:` field. Change them there.

| Setting | Value |
| --- | --- |
| Reviewers (agent → file) | `reviewer-security` → `review-security.md`, `reviewer-ux` → `review-ux.md`, `reviewer-ui` → `review-ui.md`, `reviewer-code` → `review-code.md` |
| Board keys | `security`, `ux`, `ui`, `code` |
| Max rework rounds | 2, so at most 3 review rounds |

## Paths

- Repo root: the main checkout, which stays on `main`. `R` below means its absolute path.
- Job folder: `R/factory/jobs/<job-id>/`, with `spec.md`, `build.md`, `round-<n>/review-<key>.md`, and `decision.md`.
- Worktree: `R/.worktrees/<job-id>` on branch `factory/<job-id>`. All building happens there.
- Job id: the next 3-digit number after the highest one in `board.json`, then a kebab slug of the feature, for example
  `003-rate-limiting`.

Always pass agents **absolute paths** for the job folder, the worktree and the round folder. Spawn the agents in the
background and act on their completion notices. Never guess what an agent did: read its file.

## board.json

Read it, change the job, then write the whole file to `factory/board.json.tmp` and `mv` it over `board.json`, so the
dashboard never sees half a file. Update it on **every** stage change and every verdict. Create it as `{"jobs": []}`
if it is missing.

```json
{ "jobs": [ {
  "id": "003-rate-limiting", "title": "Rate limiting", "branch": "factory/003-rate-limiting",
  "stage": "review", "round": 2,
  "reviews": { "security": "CHANGES", "ux": "PASS", "ui": "pending", "code": "PASS" },
  "history": [ { "security": "CHANGES", "ux": "PASS", "ui": "CHANGES", "code": "PASS" } ],
  "builder": "builder-003-rate-limiting", "decision": null, "note": "", "updated": "2026-10-26T12:00:00Z"
} ] }
```

- `stage` is one of `spec`, `build`, `review`, `approve`, `needs-human`, `merged`.
- `reviews` holds the current round. When the builder is sent back, push `reviews` onto `history` and reset every
  key to `pending`.
- `builder` is the name (or the id the Agent tool returned) to SendMessage to.
- `note` is one short human-readable line about the current state.

## /factory <feature>

1. **Create the job.** Pick the id, run `mkdir -p factory/jobs/<id>`, and add the job with `stage: "spec"`.
2. **Spec.** Spawn `spec-writer` with the job folder and the feature text. Wait for `spec.md`.
3. **Worktree.** Run `git worktree add .worktrees/<id> -b factory/<id> main`.
4. **Build.** Set `stage: "build"`, `round: 1`. Spawn `builder` named `builder-<id>`, giving it the job folder, the
   worktree and the branch. Record the name or id in `builder`. Wait for it to finish, and check that `build.md`
   exists and the branch has commits (`git log main..factory/<id>`).
5. **Review round n.** Run `mkdir factory/jobs/<id>/round-<n>`, then set `stage: "review"` and every review to
   `pending`. Spawn all four reviewers **in one message**, giving each the job folder, the worktree and the round
   folder. As each one finishes, read the first line of its file and set its verdict on the board.
6. **WAIT FOR ALL.** The round is done only when all four `review-*.md` files exist in the round folder. Never resume
   the builder while the round is still open. If a reviewer finishes without writing its file, spawn it again once.
   If it fails again, write its `review-<key>.md` yourself, with `VERDICT: CHANGES` on the first line and a line
   saying the reviewer failed twice, so the round can close. Set that verdict on the board, then skip steps 7 and 8:
   set `stage: "needs-human"` with the failed reviewer in `note`, because a broken reviewer is not something the
   builder can fix. Tell the user to fix the reviewer and run `/factory rework <id> <note>`.
7. **Any CHANGES**, and `n` is at most the max rework rounds: resume the builder with
   SendMessage to `builder-<id>`: "Round <n> reviews are in `<round folder>`. Address them, verify, commit, and update
   build.md." Set `stage: "build"` and `round: n+1`, push `reviews` onto `history`, and reset `reviews`. Wait for the builder, then go
   to step 5. If SendMessage can't reach the builder (for example in a new session), spawn a new `builder-<id>` with
   the same message plus the job folder, worktree and branch. The files carry the context.
8. **All PASS, or out of rounds.** Set `stage: "approve"` and spawn `approver` with the job folder and worktree. When
   rounds ran out with CHANGES left, the approver will ESCALATE.
9. **Decision.** Read the first line of `decision.md` and set `decision`.
   - `APPROVE`: merge (below), then set `stage: "merged"`.
   - `ESCALATE`: set `stage: "needs-human"`, and copy the first "Why" bullet into `note`. Tell the user what decision
     they need to make, and the commands `/factory approve <id>` and `/factory rework <id> <note>`.

## /factory next

Open `factory/backlog.md` and take the first line that starts with `- [ ]`. Run `/factory <that text>` on it. When the
job reaches `merged` or `needs-human`, change that line to `- [x] … → <job-id>`. If nothing is left unchecked, say so.

## /factory approve <job-id>

This is a human override for a `needs-human` job. Merge it (below) and set `stage: "merged"`, with
`note: "approved by human"`. Don't change `decision.md`, because it is the approver's file.

## /factory rework <job-id> <note>

1. Write the note to `round-<n>/review-human.md`, where `n` is the job's current round. The first line is
   `VERDICT: CHANGES`, then the note. This file belongs to the human, and the orchestrator writes it for them.
2. Recreate the worktree if it is gone: `git worktree add .worktrees/<id> factory/<id>`.
3. Delete any old `decision.md`, because the job is going through the loop again.
4. Go to step 7. A human rework always gets a new round, even past the max rework rounds.

## Merge to main

Running `/factory` is the user's authorization for the builder's commits on `factory/<id>` and for this merge. Do
nothing else on `main`.

1. In the main checkout: `git switch main`. Check that `git status --porcelain` lists nothing outside `factory/`. If
   it does, stop and ask the user.
2. Run `git merge --no-ff --no-commit factory/<id>`, then `bun run typecheck` and `bun test`.
3. If both pass, commit with `git commit -m "merge: factory/<id> <title>"`, plus the attribution trailer if your
   instructions require one. Then run `git worktree remove .worktrees/<id>`. Keep the branch.
4. If there is a conflict or a check fails, run `git merge --abort`, set `stage: "needs-human"` with the reason in
   `note`, and tell the user.

## Dashboard

From `factory/`, run `python3 -m http.server 8765 --bind 127.0.0.1` in the background if it isn't running yet, then open
http://127.0.0.1:8765/dashboard.html. The dashboard only reads files.
