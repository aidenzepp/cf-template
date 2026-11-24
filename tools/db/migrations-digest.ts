#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Path, Schema, Stdio } from "effect";
import { migrationsDigest } from "../../infra/migrations-digest.ts";

/**
 * The databases that carry a migrations digest: the app directory, the exported constant, and the
 * name the generated file gives the database.
 */
const databases = {
  api: { constant: "APP_MIGRATIONS_DIGEST", label: "app" },
  auth: { constant: "AUTH_MIGRATIONS_DIGEST", label: "auth" },
} as const;

/**
 * The refusal of an argument that is not one of the databases.
 */
class UnknownDatabase extends Schema.TaggedError<
  UnknownDatabase,
  { readonly brand: unique symbol }
>()("UnknownDatabase", {
  message: Schema.String,
}) {}

/**
 * Write `apps/<database>/src/db/migrations-digest.ts` from the digest of
 * `apps/<database>/migrations/`. This is the step of `db:generate` and `auth:generate` that
 * follows the database's `drizzle-kit generate`.
 *
 * Usage, from the repository root: `bun run db-migrations-digest <api|auth>`.
 */
const program = Effect.gen(function* writeDigest() {
  const [argument = ""] = yield* (yield* Stdio.Stdio).args;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const name = yield* Schema.decodeUnknownEffect(Schema.Literals(["api", "auth"]))(argument).pipe(
    Effect.mapError(
      () =>
        new UnknownDatabase({
          message: `Unknown database ${JSON.stringify(argument)}. Run: bun run db-migrations-digest <api|auth>.`,
        }),
    ),
  );

  const { constant, label } = databases[name];
  const root = yield* path.fromFileUrl(new URL(`../../apps/${name}/`, import.meta.url));
  const digest = yield* migrationsDigest(path.join(root, "migrations"));

  yield* fs.writeFileString(
    path.join(root, "src/db/migrations-digest.ts"),
    `/**
 * The digest of \`apps/${name}/migrations/\`, written by \`tools/db/migrations-digest.ts\`. A non-prod
 * ${label} database carries it in its name, so a rewritten migrations directory replaces the database
 * create-first. Never edit it by hand.
 */
export const ${constant} = "${digest}";
`,
  );
});

BunRuntime.runMain(
  program.pipe(
    Effect.tapError((failure) => Console.error(failure.message)),
    Effect.provide(BunServices.layer),
  ),
  { disableErrorReporting: true },
);
