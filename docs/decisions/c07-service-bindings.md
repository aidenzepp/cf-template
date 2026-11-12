# C7

Service-binding transport and topology knobs.

C7i `maxAge` 900 s and `fresh`; the session-check contract is C34.

C7j amended 2026-11-12: `AUTH_CHECK_SESSION_TIMEOUT_MS` defaults to 1,500 ms, not 500 ms (issue #195). On a `test-` stage with the timeout raised so none expired, `api` waited up to 960 ms for `checkSession` on a cold `auth` isolate (29 cold samples, p50 351 ms, p95 923 ms), and 5 of 19 later requests also took over 500 ms. The default is the cold maximum times 1.5, rounded up to the next 500 ms. The full table is in the pull request that closes #195. The cause is that Better Auth is built on every request; the per-isolate fix is a separate issue, and the default may fall when it lands.
