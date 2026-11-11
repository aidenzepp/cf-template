# C13

The Better Auth promise view's home.

Ruling, as `docs/architecture.md` states it:

- Under "Data ownership" (the table row "Better Auth's view", sources D1, C13, C13b): "a module-private ~30-line Proxy in `apps/auth` intercepting `then` on `Effect.isEffect`, passed to `drizzleAdapter` from `@better-auth/drizzle-adapter/relations-v2` with `{ provider: "sqlite", schema, transaction: false }`".
- Under "Package graph" (the `packages/db` row): `packages/db` does not own "the Better Auth promise view (that is `apps/auth`'s, D1)".
- Under "Lint and type configuration this plan fixes": the module is a boundary entry for the `Effect.run*` ban, its path "fixed by the data issue".
