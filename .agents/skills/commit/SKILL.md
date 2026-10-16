---
name: commit
description: Commit changes in this repo — branch check, pre-commit verification, staging, and the commit message format. Use when the user asks to commit, save work to git, or prepare changes for a PR.
---

Only commit when the user asked for it. Don't push or open a PR unless they asked for that too.

## 1. Branch

- Run `git branch --show-current`. If it's `main`, ask the user before going further: commit to `main`, or create a new branch? Suggest a branch name in the question. Don't choose for them.
- New branches are named `<type>/<short-kebab-description>`. The type is the same as the commit type (see step 4), for example `feat/tab-drag-reorder`. Create one with `git switch -c <name>`.

## 2. Verify

- Run `bun run typecheck` and `bunx biome check <changed files>`.
- If either fails because of this change, fix it before committing. Errors that already existed in untouched files don't block the commit, but mention them.

## 3. Stage

- Review `git status` and `git diff`, then stage specific paths. Don't use `git add -A` or `git add .`.
- Never stage `.temp/`, `apps/host/.data/`, `.env*`, build output (`dist`, `.output`) or anything gitignored.
- Keep commits focused: one logical change per commit. If a change mixes a formatting-only pass with real changes, commit them separately (formatting first).
- `bun.lock` goes in the same commit as the `package.json` change that caused it.

## 4. Message

By default, the message is a single line:

```sh
git commit -m "feat(web): reorder tabs by dragging within a tab bar"
```

- Format: `<type>(<scope>): <summary>`.
  - **Type** (required): `feat` (new behaviour), `fix` (bug fix), `refactor` (no behaviour change), `perf`, `style` (formatting only), `test`, `docs`, `build` (dependencies, Bun/Vite/TS config), `ci`, or `chore` (anything else). Add `!` after the type or scope for a breaking change: `feat(shared)!: …`.
  - **Scope** (optional): the workspace the change is in, `web`, `host` or `shared`. Leave the scope out when the change spans workspaces or is repo-wide.
  - **Summary:** imperative mood ("add", "fix", "move", not "added" or "adds"), lowercase start, no trailing period. Keep the whole line within 72 characters, and aim for 50.
- Add a summary body only when the subject line can't carry something a reviewer needs, such as a breaking change, a non-obvious trade-off, or a behaviour change the diff doesn't show. The body explains *why*, in a few lines wrapped at 72 columns. Never list the files changed. When there is a body, commit with a heredoc so the formatting survives:

  ```sh
  git commit -F - <<'EOF'
  refactor(shared): move tab reordering into the shared reducer

  Restarting the host is required for this, which ends running shells.
  EOF
  ```

- If your agent's instructions require an attribution trailer (for example `Co-Authored-By:`), add it after a blank line. That is the one exception to the single-line rule.

## 5. Report

Show `git log --oneline -n <count>` for the new commits, and say which branch they're on.
