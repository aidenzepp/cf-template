# C8

Domain value, origin derivation, cookies, trusted origins.

OAuth off on `test-*`; on `staging-<N>` previews OAuth goes through Better Auth's `oAuthProxy`, so every provider registers only `prod`'s `/auth/callback/<provider>` (#43 comment, items 1 to 4). `auth` runs the plugin when its stage binds `OAUTH_PROXY_SECRET` and `OAUTH_PROXY_PRODUCTION_URL`; `infra` binds them on `prod` only for now, with `prod`'s own origin, and previews wait for a source of `prod`'s origin in their deploy. C8b and C8g revisions; local origin from `WEB_DEV_PORT`.

## C8b

Ruled with C8.

## C8d

Ruled with C8.
