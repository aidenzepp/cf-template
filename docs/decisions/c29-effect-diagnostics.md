# C29

Effect diagnostics policy; `typescript` kept.

The first lint issue dispatches no earlier than 2026-11-13 11:04 UTC.

Approved as a proposal.

## C29a

Ruled with C29.

## C29b

Ruled with C29.

## C29c-1

Ruled with C29.

## C29c-2

Ruled with C29.

## C29d

Ruled with C29.

## C29e

Ruled with C29.

## C29f

Ruled with C29.

## C29g

Ruled with C29.

## C29h

Type-aware engine behind `vp check`: tsgolint now; tsrs re-checked in each type-check-toolchain Renovate PR against triggers T1 and T2, with `"diagnostics": false` the swap's invariant.

- T1: a stable tsrs on the pinned TypeScript.
- T2: `@effect/tsgo` supports it and drops experimental.

The tsconfig plugin entry keeps `"diagnostics": false` unless `Effect-TS/tsgo#1025` is closed.

Approved as a proposal.

## C29i

Any direct `oxlint` invocation pins the engine `vp check` uses, so Oxlint 1.92+ auto-pick cannot split results.

One tsrs timing baseline is recorded in the first build issue: real tree, CPU and peak RSS with load noted; synthetic tsrs figures are not quoted as a gain. The hazard turns live at the swap or when a transitive install links `tsrs-lint` into `.bin` under Oxlint 1.92 or later, which prefers it (`tsgolint.rs:1360, 1386` at `oxlint_v1.92.0`). The I-28 fixture runner and the I-29 CE2 canary carry it.

Approved as a proposal.
