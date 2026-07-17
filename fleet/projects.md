# Projects the orchestrator may dispatch into

One section per project. The orchestrator reads this BEFORE spawning or steering an agent in that project — each project's own conventions win over orchestrator defaults.

## fysiklab (space-shuttle)

- **Root:** `C:\projects\space-shuttle` (branch `dev`). Sibling worktrees: `C:\projects\space-shuttle-<name>` on branch `worktree-<name>`.
- **Dispatch:** one chat per checkout, rooted in that folder. Free worktrees are claimed via the project's own `/worktree-claim` skill (lock registry + auto-sync engine) — never create ad-hoc worktrees, never nest them.
- **Sync model:** a commit is the sync signal; commits land on `dev` automatically via the post-commit hook. Never amend or rebase after committing. Ship to `main` only via the project's `/pr-to-main`.
- **Deleting a worktree:** only `node .claude/hooks/worktree-sync.mjs remove <name>` — never a recursive delete (junction into the main checkout).
- **Verify gates:** `npm run typecheck` / `npm run lint` / `npm run check`, bare from the repo root.
