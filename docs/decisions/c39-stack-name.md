# C39

Stack-name derivation, option C.

Parts C39a to C39f follow.

## C39a

No hand-set name; derived once at bootstrap, pinned as the `STACK_NAME` repository variable (C15f-1).

## C39b

A cloud deploy reads `STACK_NAME` as required `Config` and fails naming the bootstrap when unset (C15f-2).

Fail-closed.

## C39c

Derivation order: `STACK_NAME` override, `GITHUB_REPOSITORY` in a `workflow_dispatch` bootstrap, then the `origin` URL (C15f-3).

Corrected; no package-name or directory fallback.

## C39d

Stage-safe normalization; hash suffix only on truncation (C15f-4).

## C39e

Collision check at bootstrap; the pin verified on every cloud deploy (C15f-5).

## C39f

Bootstrap stack `<stack>-bootstrap` and store `<stack>-state` from the same record (C15f-6).
