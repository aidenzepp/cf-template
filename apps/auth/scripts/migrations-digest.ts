import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Array as Arr, Effect, FileSystem, Order, Path } from "effect";
import { Digest } from "effect/crypto";
import { base32Sha256 } from "../../../infra/stages.ts";

/**
 * How many base32 characters of the digest the database name carries.
 */
const DIGEST_LENGTH = 12;

/**
 * Write `src/db/migrations-digest.ts`: the first {@link DIGEST_LENGTH} base32 characters of the
 * `sha256` over the sorted relative paths and contents of every file in `migrations/`.
 *
 * A rewritten migrations directory changes the digest, which renames the non-prod auth database,
 * so the replacement is create-first. This is the last step of `auth:generate`.
 */
const program = Effect.gen(function* writeDigest() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const directory = path.join(root, "migrations");
  const names = Arr.sort(yield* fs.readDirectory(directory, { recursive: true }), Order.String);

  const entries: string[] = [];

  for (const name of names) {
    const target = path.join(directory, name);

    if ((yield* fs.stat(target)).type === "File") {
      entries.push(`${name}\u0000${yield* fs.readFileString(target)}\u0000`);
    }
  }

  const digest = yield* base32Sha256(entries.join(""), DIGEST_LENGTH);

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
}).pipe(Effect.provide(BunServices.layer), Effect.provide(Digest.layerWebCrypto));

BunRuntime.runMain(program, { disableErrorReporting: false });
