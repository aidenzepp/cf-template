# Runbook

## Auth

Stuck sign-up address with the mail add-in on (the reclaim hook is off, so the row stays): delete the abandoned row by hand with `DELETE FROM user WHERE email_verified = 0 AND id NOT IN (SELECT user_id FROM account) AND id NOT IN (SELECT user_id FROM passkey) AND created_at < <now - AUTH_ORPHAN_GRACE_SECONDS in milliseconds>;` (`created_at` is Unix milliseconds in the generated schema).

## Limits

CPU: once a `test-<slug>` stage measures p99 CPU per invocation for a Worker, its CPU knob (`WEB_CPU_LIMIT_MS`, `API_CPU_LIMIT_MS`) becomes `max(200, ceil(p99 x 10))`.

Subrequests: once a `test-<slug>` stage measures p99 subrequests per invocation, `WORKER_SUBREQUEST_LIMIT` becomes `max(50, ceil(p99 x 10))`.

`AUTH_CPU_LIMIT_MS` follows the hash cost through `CPU_LIMIT_HEADROOM`; the hash cost is never lowered to fit a limit.

Budget guard: the latch also clears itself at the billing-period end, because the receiver puts `state` with a KV `expiration` at the start of the next UTC month.

`CPU_MS_PER_REQUEST` and `BYTES_PER_REQUEST` set the guard threshold and have no default. Measure both on a bounded `test-<slug>` run (p99 CPU per invocation and bytes served per request) and set them as deploy knobs; until both are set, no guard alert is declared.

Re-check the guard when the first project with outside users runs on `workers.dev` without an owned domain, and when a native Cloudflare spend cap becomes available to this account, after which the block is pulled out with `bun run pullout budget-guard`.

Reset a stage's latch with `bun packages/budget-guard/scripts/reset.ts --stage <stage>`: it finds the one namespace titled `<stack>-<stage>-guard`, deletes its `state` key, and prints the namespace id, title and result. `prod` is refused unless `CI=true`, and zero or several matching namespaces write nothing.

## Domain

`workers.dev` is a public suffix, so browsers isolate cookies between accounts but not between Workers of one account; the risk is accepted until an owned domain (I-26).

**Changes the origin.** Every passkey registered on `workers.dev` stops working (the RP ID is the hostname) and every session ends; OAuth callbacks must be re-registered. Do it before the first outside user, not after.

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

Observed consequence (inferred, not run): after an attach, requests to the old `workers.dev` address return Cloudflare's disabled-route response (error 1042), a pre-switch session cookie gets 401 from `/api/session` on the hostname, a passkey registered before the switch fails there, and a fresh sign-in works. A detach restores the `workers.dev` address. This stays inferred until a throwaway hostname on a zone the maintainer controls exists; the first real attach on `prod` is then the proof.

## Build and gates

`bun run build` ends with `initial JS: <n> / 300 KiB gzipped`, the web entry chunk plus its static imports. It only reports: it warns when over the target and never fails. CI repeats the line in the job summary.

I-38 fills the rest of this section.
