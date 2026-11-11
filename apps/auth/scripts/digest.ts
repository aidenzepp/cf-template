import { Array as Arr, Effect, FileSystem, Order, Path } from "effect";
import { Digest } from "effect/crypto";
import { base32Sha256 } from "../../../infra/stages.ts";

/**
 * How many base32 characters of the digest the database name carries.
 */
export const DIGEST_LENGTH = 12;

/**
 * Compute the migrations digest: the first {@link DIGEST_LENGTH} base32 characters of the `sha256`
 * over the sorted relative paths and contents of every file under `directory`.
 *
 * A rewritten migrations directory changes the digest, which renames the non-prod auth database,
 * so the replacement is create-first. The digest script writes it and a test recomputes it.
 *
 * @param directory - The absolute path of `apps/auth/migrations`.
 * @returns The digest.
 */
export const migrationsDigest = Effect.fn("migrationsDigest")(function* migrationsDigest(
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = Arr.sort(yield* fs.readDirectory(directory, { recursive: true }), Order.String);
  const entries: string[] = [];

  for (const name of names) {
    const target = path.join(directory, name);

    if ((yield* fs.stat(target)).type === "File") {
      entries.push(`${name}\u0000${yield* fs.readFileString(target)}\u0000`);
    }
  }

  return yield* base32Sha256(entries.join(""), DIGEST_LENGTH).pipe(
    Effect.provide(Digest.layerWebCrypto),
  );
});
