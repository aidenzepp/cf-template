Meter: KV

# Budget guard

A removable block. When request volume crosses the line the guard alert draws, `web` answers `503`
with a Problem Details body and `Retry-After` until the latch clears.

- The alert counts this stack's Worker invocations per `1 h` and notifies the receiver, a small
  Worker of this block (`src/receiver.ts`) with its own `workers.dev` address.
- `web` has no Alchemy init phase, so it cannot host the receiver; the receiver is the fallback
  the issue names. It writes the latch to the KV namespace `<stack>-<stage>-guard` through its KV
  binding, with an `expiration` at the period end, so the latch clears itself. No Worker holds an
  account token.
- `web` reads the latch through a plain KV binding, `GUARD_KV`, at most once per `30` s per isolate.
- `./live` is the `web` layer and `./stack` the declarations `infra` imports, so the receiver's
  platform code stays out of the bundle of `web`.
- While either `CPU_MS_PER_REQUEST` or `BYTES_PER_REQUEST` is unset, no alert is declared; the
  namespace, the receiver and the `web` layer still deploy.

The meter line also bills Cloudflare Alerting, which the meter grammar has no token for.

A pull-out leaves the `prod` namespace `<stack>-prod-guard` behind: it is retained, and holds at
most one key, `state`. Delete it by hand once the block is gone.
