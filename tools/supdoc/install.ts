import { BunCrypto, BunFileSystem, BunHttpClient, BunPath, BunRuntime } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Digest } from "effect/crypto";
import { HttpClient } from "effect/http";

/**
 * The pin file is malformed: its message names the line number and the missing field.
 */
export class PinError extends Schema.TaggedError<PinError>()("PinError", {
  message: Schema.String,
}) {}

/**
 * The archive digest differs from the pinned one, so the archive is refused.
 */
export class DigestMismatch extends Schema.TaggedError<DigestMismatch>()("DigestMismatch", {
  message: Schema.String,
}) {}

/**
 * The release archive could not be fetched.
 */
export class DownloadError extends Schema.TaggedError<DownloadError>()("DownloadError", {
  message: Schema.String,
}) {}

/**
 * The host platform and architecture have no published release binary.
 */
export class UnsupportedPlatform extends Schema.TaggedError<UnsupportedPlatform>()(
  "UnsupportedPlatform",
  {
    message: Schema.String,
  },
) {}

/**
 * The pinned release archive could not be unpacked or its binary could not be placed.
 */
export class InstallError extends Schema.TaggedError<InstallError>()("InstallError", {
  message: Schema.String,
}) {}

/**
 * One pinned release archive: the digest it must hash to and the asset file to download.
 */
export const pinEntrySchema = Schema.Struct({
  assetFile: Schema.NonEmptyString,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

/**
 * One pinned release archive: the digest it must hash to and the asset file to download.
 */
export type PinEntry = typeof pinEntrySchema.Type;

/**
 * The parsed contents of `tools/supdoc/pin.txt`: the release tag and one entry per target.
 */
export interface Pin {
  readonly tag: string;
  readonly targets: ReadonlyMap<string, PinEntry>;
}

const releaseBase = "https://github.com/aidenzepp/supdoc/releases/download";

const tagLine = /^tag (?<tag>\S+)$/u;

const decodeEntry = Schema.decodeUnknownEffect(pinEntrySchema);

/**
 * The release targets keyed by `process.platform` and `process.arch`.
 */
const hostTargets = new Map([
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["linux-x64", "x86_64-unknown-linux-musl"],
  ["linux-arm64", "aarch64-unknown-linux-musl"],
]);

/**
 * Parse one `<target> <sha256> <asset-file>` line, failing with the line number and the
 * missing or malformed field.
 */
const parseTargetLine = Effect.fn("supdoc.parseTargetLine")(function* parseTargetLine(
  line: string,
  lineNumber: number,
) {
  const [target, sha256, assetFile, ...extra] = line.split(" ");
  const missing = ["target", "sha256", "asset-file"].filter((_, field) => !line.split(" ")[field]);

  const fail = (detail: string) =>
    new PinError({
      message: `pin line ${lineNumber}: ${detail}; expected "<target> <sha256> <asset-file>", got "${line}".`,
    });

  if (missing.length > 0 || extra.length > 0 || target === undefined) {
    return yield* fail(
      missing.length > 0 ? `missing field ${missing.join(", ")}` : "unexpected extra field",
    );
  }

  const entry = yield* decodeEntry({ assetFile, sha256 }).pipe(
    Effect.mapError(() => fail("malformed sha256")),
  );

  return [target, entry] as const;
});

/**
 * Parse the pin file text. The first line is `tag <tag>`; every other line is
 * `<target> <sha256> <asset-file>`. A line that breaks the grammar, or a text with no
 * `tag` line, fails with a `PinError` naming the line number and the missing field.
 */
export const parsePin = Effect.fn("supdoc.parsePin")(function* parsePin(text: string) {
  const lines = text
    .split("\n")
    .filter((line, index, all) => line !== "" || index < all.length - 1);

  const [first = "", ...rest] = lines;
  const tag = tagLine.exec(first)?.groups?.tag;

  if (tag === undefined) {
    return yield* new PinError({
      message: `pin line 1: missing field "tag"; expected "tag <tag>", got "${first}".`,
    });
  }

  const entries = yield* Effect.all(rest.map((line, offset) => parseTargetLine(line, offset + 2)));
  const pin: Pin = { tag, targets: new Map(entries) };

  return pin;
});

/**
 * Hash bytes with SHA-256 and return the lowercase hex digest.
 */
const sha256Hex = (bytes: Uint8Array) =>
  Digest.Digest.use((digest) => digest.digestHex(Digest.sha256, bytes));

/**
 * Fail with `DigestMismatch` unless the SHA-256 digest of the bytes equals the expected hex
 * string.
 */
export const verifyDigest = Effect.fn("supdoc.verifyDigest")(function* verifyDigest(
  bytes: Uint8Array,
  expected: string,
  assetFile = "archive",
) {
  const actual = yield* sha256Hex(bytes);

  if (actual !== expected) {
    yield* new DigestMismatch({
      message: `supdoc: digest mismatch for ${assetFile}: expected ${expected}, got ${actual}; the archive is refused.`,
    });
  }
});

/**
 * Resolve the release target for a platform and architecture, or fail when no binary is
 * published for it.
 */
export const hostTarget = Effect.fn("supdoc.hostTarget")(function* hostTarget(
  platform: string,
  arch: string,
) {
  const key = `${platform}-${arch}`;
  const target = hostTargets.get(key);

  if (target === undefined) {
    return yield* new UnsupportedPlatform({
      message: `supdoc has no release binary for ${key}; supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64.`,
    });
  }

  return target;
});

/**
 * Download the archive, failing with the pinned download message on any failure.
 */
const download = Effect.fn("supdoc.download")(function* download(url: string) {
  const client = yield* HttpClient.HttpClient;

  const failure = (reason: string) =>
    new DownloadError({
      message: `supdoc: download of ${url} failed (${reason}); bun install stops until the archive can be fetched and verified.`,
    });

  const response = yield* client.get(url).pipe(Effect.mapError((error) => failure(error.message)));

  if (response.status < 200 || response.status > 299) {
    return yield* failure(`HTTP ${response.status}`);
  }

  const buffer = yield* response.arrayBuffer.pipe(
    Effect.mapError((error) => failure(error.message)),
  );

  return new Uint8Array(buffer);
});

/**
 * Return a verified archive: the cached one when its digest matches (a mismatched cache
 * file is deleted), otherwise a fresh download that must match before it is cached.
 */
const verifiedArchive = Effect.fn("supdoc.verifiedArchive")(function* verifiedArchive(
  url: string,
  cachePath: string,
  entry: PinEntry,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (yield* fs.exists(cachePath)) {
    const cached = yield* fs.readFile(cachePath);

    if ((yield* sha256Hex(cached)) === entry.sha256) {
      return cached;
    }

    yield* fs.remove(cachePath, { force: true });
  }

  const bytes = yield* download(url);

  yield* verifyDigest(bytes, entry.sha256, entry.assetFile);
  yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });
  yield* fs.writeFile(cachePath, bytes);

  return bytes;
});

/**
 * Extract the `supdoc` binary from the archive bytes.
 */
const unpackBinary = (bytes: Uint8Array, assetFile: string) =>
  // Effect has no tar API; Bun.Archive is the only unpacker available without a new dependency.
  Effect.tryPromise({
    catch: (cause) =>
      new InstallError({ message: `supdoc: could not unpack ${assetFile}: ${String(cause)}` }),
    try: async () => {
      const files = await new Bun.Archive(bytes).files("*/supdoc");
      const [binary] = files.values();

      return binary === undefined ? undefined : await binary.bytes();
    },
  }).pipe(
    Effect.flatMap((binary) =>
      binary === undefined
        ? Effect.fail(
            new InstallError({ message: `supdoc: ${assetFile} contains no supdoc binary.` }),
          )
        : Effect.succeed(binary),
    ),
  );

/**
 * Install the pinned supdoc binary at `node_modules/.bin/supdoc`, verifying the archive
 * digest on every run, cache hits included.
 */
export const install = Effect.fn("supdoc.install")(function* install() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pinPath = yield* path.fromFileUrl(new URL("pin.txt", import.meta.url));
  const pin = yield* parsePin(yield* fs.readFileString(pinPath));
  const target = yield* hostTarget(process.platform, process.arch);

  const entry = yield* Effect.fromNullishOr(pin.targets.get(target)).pipe(
    Effect.mapError(() => new PinError({ message: `pin.txt has no entry for target ${target}.` })),
  );

  const version = pin.tag.replace(/^v/u, "");
  const cacheDir = `node_modules/.cache/supdoc/${version}`;

  const bytes = yield* verifiedArchive(
    `${releaseBase}/${pin.tag}/${entry.assetFile}`,
    `${cacheDir}/${entry.assetFile}`,
    entry,
  );

  const binary = yield* unpackBinary(bytes, entry.assetFile);

  yield* fs.makeDirectory("node_modules/.bin", { recursive: true });
  yield* fs.writeFile("node_modules/.bin/supdoc", binary);
  yield* fs.chmod("node_modules/.bin/supdoc", 0o755);
});

const runtimeLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunCrypto.layerDigest,
  BunHttpClient.layer,
);

if (import.meta.main) {
  BunRuntime.runMain(install().pipe(Effect.provide(runtimeLayer)));
}
