Meter: KV

# Budget guard

A removable block. When request volume crosses the line the guard alert draws, `web` answers `503`
with a Problem Details body and `Retry-After` until the latch clears.

- The alert counts this stack's Worker invocations per `1 h` and notifies a receiver on `web`.
- The receiver writes the latch to the KV namespace `<stack>-<stage>-guard`, with an `expiration`
  at the period end, so the latch clears itself.
- While either `CPU_MS_PER_REQUEST` or `BYTES_PER_REQUEST` is unset, no alert is declared; the
  namespace and the `web` layer still deploy.

The meter line also bills Cloudflare Alerting, which the meter grammar has no token for.

A pull-out leaves the `prod` namespace `<stack>-prod-guard` behind: it is retained, and holds at
most one key, `state`. Delete it by hand once the block is gone.
