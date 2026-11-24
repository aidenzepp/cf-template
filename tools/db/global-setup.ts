import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema } from "effect";

import { generatedAuthSchema } from "./check.ts";

/**
 * Where {@link setup} leaves the generated schema text, relative to the repository root. `work/` is
 * untracked and the next run overwrites the file.
 */
export const AUTH_SCHEMA_FILE = "work/db-check-auth-schema.txt";

/**
 * The Better Auth CLI exited without writing the schema file the `auth-schema` cases compare.
 */
class AuthSchemaNotGenerated extends Schema.TaggedError<
  AuthSchemaNotGenerated,
  { readonly brand: unique symbol }
>()("AuthSchemaNotGenerated", {
  message: Schema.String,
}) {}

/**
 * Runs the Better Auth CLI once over the real tree and writes the schema text it generates to
 * {@link AUTH_SCHEMA_FILE}, through a temporary file and a rename, so a test worker never reads a
 * half-written file.
 *
 * @returns Nothing once the file is in place, or an {@link AuthSchemaNotGenerated} or the CLI's
 *   failure.
 */
const generate = Effect.fn("db.test.generate")(function* generate() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));
  const target = path.join(root, AUTH_SCHEMA_FILE);

  const text =
    (yield* generatedAuthSchema(root)) ??
    (yield* new AuthSchemaNotGenerated({
      message: "the Better Auth CLI wrote no schema file; run bun run auth:generate to see why",
    }));

  const temporary = yield* fs.makeTempFile({
    directory: path.dirname(target),
    prefix: "db-check-auth-schema-",
  });

  yield* fs.writeFileString(temporary, text);
  yield* fs.rename(temporary, target);
});

/**
 * Vitest's global setup for the `tools` project: run the Better Auth CLI once, here, and leave its
 * output for `check.test.ts`. A global setup is not bound by Vitest's `hookTimeout`, which a
 * `beforeAll` hook is, and the CLI loads the app's whole dependency graph, so a cold, contended
 * runner can spend most of that timeout on it. The cases then run `auth-schema` against this text
 * and so start no CLI.
 *
 * @returns Nothing once the file is written, or the failure.
 */
export default async function setup() {
  await Effect.runPromise(generate().pipe(Effect.provide(BunServices.layer)));
}
