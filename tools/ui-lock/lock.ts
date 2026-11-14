import { Array as Arr, Effect, FileSystem, Order, Path, Schema } from "effect";

/**
 * The lock: each file name under `packages/ui/src/components/ui/` mapped to the SHA-256 of its
 * bytes.
 */
const LockSchema = Schema.Record(Schema.String, Schema.String);

/**
 * A lock as decoded from `components.lock.json`.
 */
export type Lock = typeof LockSchema.Type;

/**
 * The tree whose files the lock covers.
 */
export const componentsDirectory = "packages/ui/src/components/ui";

/**
 * The committed lock file.
 */
export const lockFile = "packages/ui/components.lock.json";

/**
 * Raised when the component tree and the committed lock disagree. The message names every added,
 * removed and edited file and the command that rewrites the lock.
 */
class LockMismatchError extends Schema.TaggedError<
  LockMismatchError,
  { readonly brand: unique symbol }
>()("LockMismatchError", {
  message: Schema.String,
}) {}

const decodeLock = Schema.decodeUnknownEffect(Schema.fromJsonString(LockSchema));

/**
 * Raised when the Web Crypto digest of a file fails.
 */
class HashError extends Schema.TaggedError<HashError, { readonly brand: unique symbol }>()(
  "HashError",
  {
    message: Schema.String,
  },
) {}

/**
 * The lowercase hex SHA-256 of `bytes`.
 */
const hashBytes = Effect.fn("ui-lock.hashBytes")(function* hashBytes(bytes: Uint8Array) {
  const digest = yield* Effect.tryPromise({
    catch: () => new HashError({ message: "Web Crypto could not compute a SHA-256 digest" }),
    try: () => crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  });

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
});

/**
 * The lock for `files`, a map of file name to bytes, with names in sorted order.
 */
export const hashFiles = Effect.fn("ui-lock.hashFiles")(function* hashFiles(
  files: Readonly<Record<string, Uint8Array>>,
) {
  const entries = yield* Effect.forEach(Arr.sort(Object.keys(files), Order.String), (name) =>
    Effect.map(hashBytes(files[name] ?? new Uint8Array()), (hash) => [name, hash] as const),
  );

  return Object.fromEntries(entries) satisfies Lock;
});

/**
 * Reads every file directly under `directory` into a map of file name to bytes.
 */
export const readTree = Effect.fn("ui-lock.readTree")(function* readTree(directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(directory);

  const entries = yield* Effect.forEach(names, (name) =>
    Effect.map(fs.readFile(path.join(directory, name)), (bytes) => [name, bytes] as const),
  );

  return Object.fromEntries(entries);
});

/**
 * The lines describing how `actual` differs from `expected`: one per added, removed or edited file.
 */
export const diffLock = (expected: Lock, actual: Lock): ReadonlyArray<string> => [
  ...Object.keys(actual)
    .filter((name) => !(name in expected))
    .map((name) => `added: ${name}`),
  ...Object.keys(expected)
    .filter((name) => !(name in actual))
    .map((name) => `removed: ${name}`),
  ...Object.keys(actual)
    .filter((name) => name in expected && expected[name] !== actual[name])
    .map((name) => `edited: ${name}`),
];

/**
 * Hashes the tree at `directory`.
 */
const computeLock = Effect.fn("ui-lock.computeLock")(function* computeLock(directory: string) {
  return yield* hashFiles(yield* readTree(directory));
});

/**
 * Writes the lock for the tree at `directory` to `file`.
 */
export const writeLock = Effect.fn("ui-lock.writeLock")(function* writeLock(
  directory: string,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.writeFileString(file, `${JSON.stringify(yield* computeLock(directory), null, 2)}\n`);
});

/**
 * Fails with `LockMismatchError` when the tree at `directory` does not match the lock at `file`.
 */
export const checkLock = Effect.fn("ui-lock.checkLock")(function* checkLock(
  directory: string,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;

  const differences = diffLock(
    yield* decodeLock(yield* fs.readFileString(file)),
    yield* computeLock(directory),
  );

  return yield* differences.length > 0
    ? new LockMismatchError({
        message: `${directory} does not match ${file}:\n${differences.join("\n")}\nRun \`bun run ui:lock\` to reinstall the stock components and rewrite the lock.`,
      })
    : Effect.void;
});
