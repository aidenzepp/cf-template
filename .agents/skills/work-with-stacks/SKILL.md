---
name: work-with-stacks
description: Deploy, inspect and destroy Alchemy stages from a laptop, count orphans before and after, and know what never runs here. Use when running `bun run alchemy` for dev, plan, deploy, destroy or state commands, or when proving a stack change with a test-<slug> round trip.
---

# Work With Stacks

The application stack program is `infra/alchemy.run.ts`. Every command goes through the
root script, which sets `ALCHEMY_TELEMETRY_DISABLED=1`:

```sh
bun run alchemy <command> --stage <stage> infra/alchemy.run.ts
```

## Rules

- Pass `--stage` every time. The CLI default (`live_$USER`) is rejected by the Stage Schema.
- Pass the entry point `infra/alchemy.run.ts` as the positional argument. The CLI looks for
  `alchemy.run.ts` in the current directory and the repository has none at its root.
- Cloudflare auth is the Alchemy default profile. Never read, print, copy or log profile
  contents or tokens, and never export a raw `CLOUDFLARE_API_TOKEN` to work around it.
- `--yes` is allowed only through `bun infra/scripts/test-stage.ts <deploy|destroy> <stage>`.
  The script refuses, before any `alchemy` call, unless the stage matches
  `^test-[a-z0-9-]+$` and the stack program keeps it on local state (`usesProjectState` is
  false). `test-ci`, `dev`, `prod` and `staging-<N>` are refused. Never pass `--yes` to
  `alchemy` directly, never to a stage in a state store, and never to `staging-<N>` or `prod`.
- Never target the account's shared `alchemy-state-store`.
- Never deploy, destroy, plan or `dev` stage `prod` or `staging-<N>` from a laptop. The stack
  program refuses `prod` without `CI=true` before it declares any resource. Those stages
  belong to CI.

## State

| Stage | State |
| --- | --- |
| `test-<slug>`, `dev` | Alchemy local state in `.alchemy/` (ignored by git) |
| `prod`, `staging-<N>`, `test-ci` | the project store `Cloudflare.state({ workerName: "<stack>-state" })` |

`<stack>` is printed by `bun infra/scripts/stack-name.ts`. The store is bootstrapped by the
maintainer with the `admin` profile, never by a laptop deploy. A stage destroy does not
remove the store.

## Dev

`bun run alchemy dev --stage dev infra/alchemy.run.ts` runs the Workers locally on Miniflare
with local state. It is the only stage `dev` accepts.

## Round trip on `test-<slug>`

1. Record the before counts (below).
2. `bun infra/scripts/test-stage.ts deploy test-<slug>`
3. Make the few requests the proof needs. No load, volume or soak.
4. `bun infra/scripts/test-stage.ts destroy test-<slug>`
5. Record the after counts. Every count must equal its before count. A leftover blocks the
   report: name it exactly and delete only what this unit created.

Deploy and destroy ask for approval, and a non-interactive shell stops with "Nothing was
changed". The script passes the guarded `--yes`, so no approval prompt remains for a
`test-<slug>` stage.

## Count procedure

Record three counts, before the deploy and after the destroy:

- State: `bun run alchemy state list --backend local -r` (the local store is addressed by
  path `<stack-id>/<stage>`; `state list` takes no `--stage`).
- Workers: scripts on the account whose name starts with `<stack>-`.
- D1: databases on the account whose name starts with `<stack>-`.

State Secrets Store secrets as 0 and 0 while no stack declares one. For the two account
lists, run a read-only stack file kept under the gitignored `work/` that reads
`Cloudflare.CloudflareEnvironment.current` for the profile's credentials and account id,
calls `workers/scripts` and `d1/database` with pagination, and prints only the matching
names and counts. Run it with `bun run alchemy plan --stage test-<slug> work/<file>.ts`;
it declares no resource, so the plan changes nothing. Never print the credentials.

## Prod refusal check

```sh
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID -u CI \
  bun run alchemy deploy --stage prod infra/alchemy.run.ts
```

Expect a non-zero exit and `ProdStageRefused` before any API call. The same with `destroy`.
