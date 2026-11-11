# C38

Worktree-safe hook installation.

Ruling, as `docs/architecture.md` states it:

- Under "Scope" (the Gates row, owner rows C20, C21, C38): "tracked hooks `pre-push` (`check`, `build`, `test`), `commit-msg`, `post-merge`".
- Under "Resolved disagreements": `AGENTS.md`-only hooks against fix A tracked hooks is settled as "fix A (C38)".
- Under "Gate composition": `prepare` runs "`git config --local core.hooksPath .vite-hooks`", and `bun run check` begins with `tools/hooks/present.ts`, "pre-push hook resolvable (C38 Q4, H3); runs in CI unchanged".

The plan does not state why the install is worktree-safe; no ruling text for that is recorded here.
