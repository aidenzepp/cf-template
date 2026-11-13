# Runbook

## Auth

Stuck sign-up address with the mail add-in on (the reclaim hook is off, so the row stays): delete the abandoned row by hand with `DELETE FROM user WHERE email_verified = 0 AND id NOT IN (SELECT user_id FROM account) AND id NOT IN (SELECT user_id FROM passkey) AND created_at < <now - AUTH_ORPHAN_GRACE_SECONDS in milliseconds>;` (`created_at` is Unix milliseconds in the generated schema).

Rejected sign-in lookup: `bun run log-key --stage <stage> <email>` prints the `emailKey` hash to search for in Workers Logs. It refuses a stage whose state store is missing or outdated and never deploys one. A maintainer runs `prod` locally with `CI=true` on purpose; no workflow may run `log-key`, because this repository is public and an Actions log would show the address and its hash.

## Limits

CPU: once a `test-<slug>` stage measures p99 CPU per invocation for a Worker, its CPU knob (`WEB_CPU_LIMIT_MS`, `API_CPU_LIMIT_MS`) becomes `max(200, ceil(p99 x 10))`.

Subrequests: once a `test-<slug>` stage measures p99 subrequests per invocation, `WORKER_SUBREQUEST_LIMIT` becomes `max(50, ceil(p99 x 10))`.

`AUTH_CPU_LIMIT_MS` follows the hash cost through `CPU_LIMIT_HEADROOM`; the hash cost is never lowered to fit a limit.

Budget guard: the latch also clears itself at the billing-period end, because the receiver puts `state` with a KV `expiration` at the start of the next UTC month.

`CPU_MS_PER_REQUEST` and `BYTES_PER_REQUEST` set the guard threshold and have no default. Measure both on a bounded `test-<slug>` run (p99 CPU per invocation and bytes served per request) and set them as deploy knobs; until both are set, no guard alert is declared.

Re-check the guard when the first project with outside users runs on `workers.dev` without an owned domain, and when a native Cloudflare spend cap becomes available to this account, after which the block is removed: delete `Layer.mergeAll(BudgetGuardLive)` in `apps/web/src/request-layers.ts` (the Layer attach), its stack lines in `infra/alchemy.run.ts`, its `budget-guard` test project in `vite.config.ts`, and the files it owns (`packages/budget-guard/`, `packages/config/src/budget-guard.ts` and its test, `infra/src/guard-*.ts`), then run `bun run check` and `bun run test`.

Reset a stage's latch with `bun packages/budget-guard/scripts/reset.ts --stage <stage>`: it finds the one namespace titled `<stack>-<stage>-guard`, deletes its `state` key, and prints the namespace id, title and result. `prod` is refused unless `CI=true`, and zero or several matching namespaces write nothing.

## Domain

`workers.dev` is a public suffix, so browsers isolate cookies between accounts but not between Workers of one account; the risk is accepted until an owned domain (I-26).

**Changes the origin.** Every passkey registered on `workers.dev` stops working (the RP ID is the hostname), and browsers sign in again because their session cookie stays scoped to the old host while server-side sessions stay valid until they expire; OAuth callbacks must be re-registered. Do it before the first outside user, not after.

Prerequisites: the hostname's zone is active in the deploying Cloudflare account, the hostname has no existing CNAME, and the zone has no wildcard record. The deploy touches the zone only to attach the hostname. The WAF rate-limit rule (50 requests per 10 s per IP outside `/assets/`, blocked for 10 s) is defined in `infra/src/domain.ts` but not yet declared on the zone: the pinned `Cloudflare.Ruleset` takes a `Zone` resource, which would create or patch the zone, so it waits on a ruling.

Attach:

1. Set the `CUSTOM_DOMAIN` repository variable to the hostname, for example `app.example.com`.
2. Deploy `prod`. `web` is served on the hostname, `workers.dev` is turned off, and `PUBLIC_ORIGIN` becomes `https://<hostname>`.
3. Re-register every OAuth callback in the provider's console at `${PUBLIC_ORIGIN}/auth/callback/<provider>`.

Detach:

1. Set `CUSTOM_DOMAIN` to `workers-dev`.
2. Deploy `prod`. The hostname is detached (`domain: null`), `workers.dev` is on again and `PUBLIC_ORIGIN` returns to the `workers.dev` address. Callbacks and passkeys move back the same way.

A zone's rate-limit phase has one owner. Cloudflare keeps one `http_ratelimit` entrypoint per zone and a `Cloudflare.Ruleset` will write the whole of it, so a deploy would overwrite rules added in the dashboard or by another project. Before declaring anything, a stage that attaches a hostname reads the zone's entrypoint and refuses with `ForeignRateLimitRules` (naming the zone and the foreign rule ids) when it holds a rule without this stack's `ref` (`<stack>-<stage>-web-ratelimit-<hostname>`, dots as `_`). An absent entrypoint (code 10003) or an empty one passes; any other failed read refuses the deploy with `RateLimitEntrypointError`, and the token needs Zone Read and Zone WAF Read. Once the Ruleset is declared, destroy will remove the rules the stack deployed. To clear a refusal, remove or move the foreign rules in the dashboard, or point the stage's variable (`CUSTOM_DOMAIN` on `prod`, `STAGES_TEST_CUSTOM_DOMAIN` on a test stage) at a zone with no other rate-limit rules. The check runs at plan time, so a rule added between plan and apply is still overwritten.

`prod` reads `CUSTOM_DOMAIN`. A `test-<slug>` stage ignores it and reads `STAGES_TEST_CUSTOM_DOMAIN` only when the deploy environment sets it; unset, it stays on `workers.dev`. `staging-<N>` and `dev` refuse `CUSTOM_DOMAIN`.

Observed consequence (test-i26 run, 2026-11-13): after an attach, requests to the old `workers.dev` address returned Cloudflare's disabled-route response (error 1042). A browser that had signed in on `workers.dev` landed signed out on the hostname, because its session cookie is scoped to the `workers.dev` host. The server-side session was not ended: it stays valid until it expires (7 days), and replaying the pre-switch session token against the hostname still answered 200 on `/api/session`. A passkey registered before the switch failed on the hostname, because the RP ID follows the new origin. A fresh sign-in on the hostname worked. After a detach the `workers.dev` address answered the app again and the pre-switch session token was still accepted there.

**Do not resolve the new hostname before attaching.** Resolvers cache the NXDOMAIN answer for up to 30 minutes (the zone's negative TTL was 1800 s in the run), so a lookup made before the deploy can leave the hostname unreachable from that resolver until the cache expires.

## Projections

A projection, such as `NoteIndex` in `apps/api/src/notes/note-index.projection.ts`, consumes the domain event log into a store the app owns. Delivery is at least once per input, so every handler write is an idempotent upsert keyed by the event's `stream` and `seq`.

**Rebuild.** The pinned `@alchemy.run/domain` (beta.85) rebuilds a projection only when its declared version rises. Pass a higher `version` in the options of its `toLayer` call (`NoteIndex.toLayer(noteIndexHandler, { version: 1 })`; it is `0` when omitted) and deploy. The projection, and every view or projection that reads it, then replays the whole history. Clear or migrate the store first when a replayed write would not overwrite the old row; the `NoteIndex` upsert does overwrite it. Use it after the store was lost or emptied, or when the handler writes a new row shape.

**Position.** The package has no public call that reads a projection's position or starts a rebuild from outside the Worker: the per-key cursors live in the Durable Objects that host the model, and a script cannot read them. Inside the Worker, `NoteIndex.caughtUp(receipt)` waits until one command's events are handled, and the projection's `Progress.history` reports whether the history has reached it.

**Health.** The package records `domain.runs` (a counter by `domain.kind`, `domain.consumer` and `domain.outcome`) and `domain.lag` (a histogram of milliseconds from commit to handling, by `domain.consumer`) as Effect metrics inside the Worker. Nothing exports them, and the `Domain.projection <name>` span of each run goes to Workers Traces, not `logs.workersLogs`, so neither can back an alert. Instead a failed run of the `NoteIndex` handler writes one `console.error` line, `{"consumer":"NoteIndex","event":"domain.run.failed","kind":"projection","outcome":"failed"}`, and the projection failure alert (`projectionFailureAlert` in `infra/src/alerts.ts`, named `<stack>-projection-failure-NoteIndex-<stage>`, on the stages that set `volumeAlert`) emails `ISSUE_NOTIFICATION_EMAIL` when more than 2 such lines from `api` land in a 15 minute window. A failed run is retried, so a handler that keeps failing crosses it quickly. A new projection adds the same line to its handler and its name to `ProjectionConsumers`. There is no lag alert: `domain.lag` has no log form yet. To see what failed, find the errored `Domain.projection <name>` span (attributes `domain.projection`, `domain.key`, `domain.batch`) in the `api` Worker's traces.

## Build and gates

`bun run build` ends with `initial JS: <n> / 300 KiB gzipped`, the web entry chunk plus its static imports. It only reports: it warns when over the target and never fails. CI repeats the line in the job summary.

`merge-gate` in `deploy.yml` is the required check. It covers `checks`, `browser` and `design-record` and fails unless each one succeeded; on a push to `main`, where `design-record` does not run, it accepts that job as skipped. On a pull request while `CLOUDFLARE_DEPLOYS` is `true` it also requires `cloud`, which runs only with the `merge-ready` label. The settings program applies the ruleset that requires it at stop point S-19, after the account holder's go, so until S-19 runs the job reports but nothing requires it.

**GitHub App.** Agents push, open pull requests and merge as the repository's GitHub App, never with the maintainer's token. Install the App on each repository that uses it: one click per repository, because "All repositories" is not chosen. Its id and private key are the repository secrets `APP_ID` and `APP_PRIVATE_KEY`; the key never enters the repository, a `.env` file or a log line. A seat acts as the App with an installation token minted through GitHub's documented flow: sign a JWT with the private key, exchange it at `POST /app/installations/{installation_id}/access_tokens`, and use the token as `GH_TOKEN` and as the `x-access-token` git credential. The token expires after 3600 s; mint a new one rather than extending it. The key reaches a seat only through `op run --env-file .env.op`. In a workflow, `.github/actions/app-token` mints the token from the same two secrets.

**Prod.** `prod.yml` deploys `main` to `prod` only on a `destructive=false` plan; a destructive plan holds the run red with a fingerprint. To apply it, the owner dispatches `prod-destructive.yml` with the held `sha`, its `fingerprint` and a `reason`. Never re-run `confirm`: dispatch again, so the new run re-plans against the current state and the actor check sees who started it. A dispatch the App or an agent started reports `confirm` as skipped. `prod-knob.yml` changes one live knob on `prod` under the same owner check; its run log is the record.

**Red `deploy-prod`.** A failed deploy can leave the D1 migration applied while the previous Worker version serves the new schema. Fix forward: land a fix on `main` and let `prod.yml` deploy it. Never write a down migration.

**Manual route stop.** A distributed flood has no automatic stop on day one. Stop it by disabling `web`'s `workers.dev` route in the Cloudflare dashboard, or set `workersDev: false` on `web` and redeploy.

A Better Auth bump reaches `prod` before its previews sign in with a provider: `oAuthProxy`'s encrypted packages do not cross versions when its key derivation changes, so `prod` and every participating preview move in one cutover.

## State store

Create the project state store once, from a laptop, before the first deploy: `bun run alchemy state bootstrap --profile admin --config infra/alchemy.run.ts`. It creates the `<stack>-state` Worker and its two Secrets Store entries in the `admin` profile's account, with `STACK_NAME` when set and the derived name otherwise. The command passes no stage, so Alchemy builds the state layer with its placeholder stage (`PLACEHOLDER_STAGE`, `alchemy/src/Alchemist/Operations.ts`); `infra/alchemy.run.ts` builds the project store for that stage without decoding it as an app stage. Every deploy stage still decodes strictly.

I-38 fills the rest of this section.
