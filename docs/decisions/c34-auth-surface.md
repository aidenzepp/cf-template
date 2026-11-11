# C34

The auth surface: no public address, wholesale `/auth/*` forward, internal RPC.

Ruling, as `docs/architecture.md` states it under "Request path" and its rules table:

- C34a: "`api` and `auth` run with `workersDev: false`, no domain, no routes", proved on `test-r-auth-surface` (the would-be host answers Cloudflare 1042).
- C34b: "`/auth/*` is forwarded wholesale; Better Auth's `basePath` is the shared `AUTH_BASE_PATH` constant (`"/auth"`) in `@workspace/auth/contract` with an explicit per-stage `baseURL`".
- C34c: the session check calls `getSession({ disableRefresh: true })` from the signed cookie cache, with `disableCookieCache` when fresh.
- C34f: "Internal auth capabilities sit on the default entrypoint in the Effect form (R1), structurally unreachable over HTTP; a method that mutates, enumerates, or takes anything but the caller's own cookie as identity waits for R2".
- C34g: "`web` may only call `fetch` on the `AUTH` binding; `checkSession` from `web` is a type error and a lint error".
