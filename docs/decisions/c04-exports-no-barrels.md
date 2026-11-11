# C4

Export style: subpaths, no barrels.

Ruling, as `docs/architecture.md` states it under "Package graph":

> Explicit `exports` maps, no `.` entry, no barrels (C4); `packages/ui` alone exports per-directory wildcards (C10k, LR-2 (a)).

The per-directory wildcard for `packages/ui` is ruled in C10 (`c10-ui-kit.md`).
