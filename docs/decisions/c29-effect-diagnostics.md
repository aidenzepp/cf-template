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

Type-aware engine behind `vp check`: tsrs, since Vite+ 1.7.0 (#433). Vite+ 1.7.0 ships tsrs 7.1.0-beta.tsrs2 in place of oxlint-tsgolint; `@effect/tsgo` patches it with the experimental `--tsrs` (`prepare` runs `effect-tsgo patch --oxlint --tsrs`), with `"diagnostics": false` the invariant.

- T1: a stable tsrs on the pinned TypeScript. Not met: tsrs targets the TypeScript 7.1 beta line while 7.0.2 is pinned.
- T2: `@effect/tsgo` supports it and drops experimental. Not met: `@effect/tsgo` 0.73.2 lists tsrs 7.1.0-beta.tsrs2 and still marks the patch experimental.

The adoption accepts both as unmet: the operator's brief for #433, tsrs in place of oxlint-tsgolint, rules it. The tsconfig plugin entry keeps `"diagnostics": false` unless `Effect-TS/tsgo#1025` is closed.

The account holder accepted this override on 2026-11-23, relayed through the lint campaign, with both triggers unmet: no stable tsrs, and a `--tsrs` patch that is still experimental. Those two triggers stay the signal to revisit it.

Approved as a proposal.

## C29i

Any direct `oxlint` invocation pins the engine `vp check` uses, so Oxlint 1.92+ auto-pick cannot split results.

The hazard is live: Vite+ 1.7.0 runs `tsrs-lint` by setting `OXLINT_TSGOLINT_PATH` to it, and the I-28 fixture runner and the I-29 CE2 canary set the same variable to the `tsrs-lint` of Vite+'s own install. First real timing, one uncontrolled run each on the real tree: `vp check --deny-warnings` took 12.8 s wall and 2.1 GB peak RSS with tsgolint on Vite+ 1.5.0, and 7.3 s and 0.97 GB with tsrs on 1.7.0; synthetic tsrs figures are not quoted as a gain.

Approved as a proposal.
