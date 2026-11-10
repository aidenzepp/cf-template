# C29

Effect diagnostics policy; `typescript` kept.

Approved as a proposal.

## C29h

Type-aware engine behind `vp check`: tsgolint now; tsrs re-checked in each type-check-toolchain Renovate PR against triggers T1 and T2, with `"diagnostics": false` the swap's invariant.

- T1: a stable tsrs on the pinned TypeScript.
- T2: `@effect/tsgo` supports it and drops experimental.

The tsconfig plugin entry keeps `"diagnostics": false` unless `Effect-TS/tsgo#1025` is closed.

Approved as a proposal.

## C29i

Any direct `oxlint` invocation pins the engine `vp check` uses, so Oxlint 1.92+ auto-pick cannot split results.

Approved as a proposal.
