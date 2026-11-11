import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { migrationsDigest } from "../../auth/scripts/digest.ts";

/**
 * Write `src/db/migrations-digest.ts` from the digest of `migrations/`. This is the step of
 * `db:generate` that follows the app's `drizzle-kit generate`.
 */
const program = Effect.gen(function* writeDigest() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const digest = yield* migrationsDigest(path.join(root, "migrations"));

  yield* fs.writeFileString(
    path.join(root, "src/db/migrations-digest.ts"),
    `/**
 * The digest of \`apps/api/migrations/\`, written by \`scripts/migrations-digest.ts\`. A non-prod
 * app database carries it in its name, so a rewritten migrations directory replaces the database
 * create-first. Never edit it by hand.
 */
export const APP_MIGRATIONS_DIGEST = "${digest}";
`,
  );
}).pipe(Effect.provide(BunServices.layer));

BunRuntime.runMain(program, { disableErrorReporting: false });
