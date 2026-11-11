import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { migrationsDigest } from "./digest.ts";

/**
 * Write `src/db/migrations-digest.ts` from the digest of `migrations/`. This is the last step of
 * `auth:generate`.
 */
const program = Effect.gen(function* writeDigest() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const digest = yield* migrationsDigest(path.join(root, "migrations"));

  yield* fs.writeFileString(
    path.join(root, "src/db/migrations-digest.ts"),
    `/**
 * The digest of \`apps/auth/migrations/\`, written by \`scripts/migrations-digest.ts\`. A non-prod
 * auth database carries it in its name, so a rewritten migrations directory replaces the database
 * create-first. Never edit it by hand.
 */
export const AUTH_MIGRATIONS_DIGEST = "${digest}";
`,
  );
}).pipe(Effect.provide(BunServices.layer));

BunRuntime.runMain(program, { disableErrorReporting: false });
