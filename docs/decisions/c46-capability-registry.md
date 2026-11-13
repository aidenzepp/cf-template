# C46

Capability registry: each concern has one mechanism, listed in [docs/capabilities.md](../capabilities.md) with the lint rule that enforces it.

The ladder in `AGENTS.md` gains a rung between the Effect rung and code in this repository: an installed dependency or the stack's standard library. A library the registry lists needs no further reason to be added beyond naming its registry row. A new helper or hook names its registry row, or the API checked and the requirement that API fails, in the pull request's "Native capability check" section.

`tools/capabilities/registry.test.ts` keeps the registry in step with the lint configuration: every named guard rule is configured, and every guard still pending is listed in the test until its rule lands.

Source: the native-capability audit and the TanStack ecosystem review (operator letter 8ef43917, work order A).

## C46a

Toasts: screens call sonner's `toast` directly; the `notify` pass-through and the `sonner` import ban are removed. `routes/__root.tsx` keeps the one `<Toaster>`.

## C46b

Follow-up: a CI step that reads the pull request body and fails on `N/A` in "Native capability check" when the diff adds a hook or a `components/*/` directory.
