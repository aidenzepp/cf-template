# C42

External dependencies under the own-code principle.

Ruling, as `docs/architecture.md` states it under "External dependencies (C42, E1-E12)":

> No paid third-party service on day one. The criterion: external means an account, a key or possible payment; runner code with no grant is not.

The same section lists what is kept, what is configured ("Alchemy telemetry off"), what is deferred and what is not a template dependency ("1Password, LLM agents"). Two further rulings cite C42:

- "`ALCHEMY_TELEMETRY_DISABLED=1` in the `alchemy` script and every workflow `env:` (C42)".
- Every workflow `uses:` is "SHA-pinned under the native repository setting (C42)".
