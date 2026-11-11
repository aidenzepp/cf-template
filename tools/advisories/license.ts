import { BunCrypto, BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Digest } from "effect/crypto";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The pin file is malformed: its message names the line number and the missing field.
 */
export class PinError extends Schema.TaggedError<PinError>()("PinError", {
  message: Schema.String,
}) {}

/**
 * The command line has an argument this script does not take.
 */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

/**
 * The scanner binary differs from the pinned digest, so it is refused.
 */
export class DigestMismatch extends Schema.TaggedError<DigestMismatch>()("DigestMismatch", {
  message: Schema.String,
}) {}

/**
 * The scanner binary could not be fetched.
 */
export class DownloadError extends Schema.TaggedError<DownloadError>()("DownloadError", {
  message: Schema.String,
}) {}

/**
 * The host platform and architecture have no pinned scanner binary.
 */
export class UnsupportedPlatform extends Schema.TaggedError<UnsupportedPlatform>()(
  "UnsupportedPlatform",
  { message: Schema.String },
) {}

/**
 * The licenses this tree is allowed to carry, as SPDX identifiers. Seeded by one run of the pinned
 * scanner in summary mode (`--licenses` with no allowlist) on this tree, listing only the licenses
 * present, with each compound expression split into its identifiers.
 */
export const ALLOWED_LICENSES: ReadonlyArray<string> = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
];

/**
 * What the command line selects: the allowlist that replaces the constant, and the directory to
 * scan.
 */
export interface Options {
  readonly allow: ReadonlyArray<string> | undefined;
  readonly dir: string | undefined;
}

/**
 * The pinned release: its tag and the SHA-256 digest of each asset.
 */
export interface Pins {
  readonly assets: ReadonlyMap<string, string>;
  readonly tag: string;
}

const releaseBase = "https://github.com/google/osv-scanner/releases/download";

const tagLine = /^tag (?<tag>v\d+\.\d+\.\d+)$/u;

const assetLine = /^(?<asset>osv-scanner_\w+) (?<sha256>[0-9a-f]{64})$/u;

/**
 * The release assets keyed by `process.platform` and `process.arch`.
 */
const hostAssets = new Map([
  ["darwin-arm64", "osv-scanner_darwin_arm64"],
  ["linux-x64", "osv-scanner_linux_amd64"],
]);

/**
 * The `--licenses` argument for an allowlist: the identifiers joined by commas.
 */
export const licensesFlag = (allow: ReadonlyArray<string>): string =>
  `--licenses=${allow.join(",")}`;

/**
 * Reads `--dir <path>` and `--allow <spdx,...>` from the arguments after the script name. A bare
 * `--` is skipped, so `bun run license -- --allow MIT-0` works.
 */
export const parseOptions = Effect.fn("advisories.parseOptions")(function* parseOptions(
  argv: ReadonlyArray<string>,
) {
  const args = argv.filter((arg) => arg !== "--");
  const dirAt = args.indexOf("--dir");
  const allowAt = args.indexOf("--allow");
  const known = new Set([dirAt, allowAt].flatMap((at) => (at === -1 ? [] : [at, at + 1])));
  const stray = args.find((_, index) => !known.has(index));

  if (stray !== undefined) {
    return yield* new UsageError({
      message: `license: unknown argument "${stray}"; expected [--dir <path>] [--allow <spdx,...>].`,
    });
  }

  if (
    (dirAt !== -1 && args[dirAt + 1] === undefined) ||
    (allowAt !== -1 && args[allowAt + 1] === undefined)
  ) {
    return yield* new UsageError({
      message: "license: a flag has no value; expected [--dir <path>] [--allow <spdx,...>].",
    });
  }

  const options: Options = {
    allow: allowAt === -1 ? undefined : args[allowAt + 1]?.split(","),
    dir: dirAt === -1 ? undefined : args[dirAt + 1],
  };

  return options;
});

/**
 * Parses the pin file text: `tag v<version>` first, then one `<asset> <sha256>` line per asset. A
 * line that breaks the grammar fails with a `PinError` naming the line number.
 */
export const parsePins = Effect.fn("advisories.parsePins")(function* parsePins(text: string) {
  const lines = text
    .split("\n")
    .filter((line, index, all) => line !== "" || index < all.length - 1);

  const [first = "", ...rest] = lines;
  const tag = tagLine.exec(first)?.groups?.tag;

  if (tag === undefined) {
    return yield* new PinError({
      message: `pin line 1: missing field "tag"; expected "tag v<version>", got "${first}".`,
    });
  }

  const entries = yield* Effect.all(
    rest.map((line, offset) => {
      const found = assetLine.exec(line)?.groups;

      return found?.asset === undefined || found.sha256 === undefined
        ? Effect.fail(
            new PinError({
              message: `pin line ${offset + 2}: expected "<asset> <sha256>", got "${line}".`,
            }),
          )
        : Effect.succeed([found.asset, found.sha256] as const);
    }),
  );

  const pins: Pins = { assets: new Map(entries), tag };

  return pins;
});

/**
 * Resolves the pinned asset for a platform and architecture, or fails when none is pinned.
 */
export const hostAsset = Effect.fn("advisories.hostAsset")(function* hostAsset(
  platform: string,
  arch: string,
) {
  const asset = hostAssets.get(`${platform}-${arch}`);

  if (asset === undefined) {
    return yield* new UnsupportedPlatform({
      message: `license: no osv-scanner binary is pinned for ${platform}-${arch}; supported: darwin-arm64, linux-x64.`,
    });
  }

  return asset;
});

/**
 * Hashes bytes with SHA-256 and returns the lowercase hex digest.
 */
const sha256Hex = (bytes: Uint8Array) =>
  Digest.Digest.use((digest) => digest.digestHex(Digest.sha256, bytes));

/**
 * Fails with `DigestMismatch`, naming the asset and both digests, unless the bytes hash to the
 * expected digest.
 */
export const verifyDigest = Effect.fn("advisories.verifyDigest")(function* verifyDigest(
  bytes: Uint8Array,
  expected: string,
  asset: string,
) {
  const actual = yield* sha256Hex(bytes);

  if (actual !== expected) {
    yield* new DigestMismatch({
      message: `license: digest mismatch for ${asset}: expected ${expected}, got ${actual}; the binary is refused.`,
    });
  }
});

/**
 * Downloads one release asset.
 */
const download = Effect.fn("advisories.download")(function* download(url: string) {
  const client = yield* HttpClient.HttpClient;

  const failure = (reason: string) =>
    new DownloadError({ message: `license: download of ${url} failed (${reason}).` });

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
 * The cache path of the scanner binary under `root`, in the gitignored `node_modules/.cache`.
 */
export const cachedBinary = (path: Path.Path, root: string, pins: Pins, asset: string): string =>
  path.join(root, "node_modules/.cache/osv-scanner", pins.tag.replace(/^v/u, ""), asset);

/**
 * Returns the path of the verified scanner binary: the cached file when its digest matches (a
 * mismatched cache file is deleted), otherwise a fresh download that must match before it is
 * written.
 */
const ensureBinary = Effect.fn("advisories.ensureBinary")(function* ensureBinary(
  root: string,
  pins: Pins,
  asset: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expected = pins.assets.get(asset);

  if (expected === undefined) {
    return yield* new PinError({ message: `pin file has no entry for ${asset}.` });
  }

  const target = cachedBinary(path, root, pins, asset);

  if (yield* fs.exists(target)) {
    if ((yield* sha256Hex(yield* fs.readFile(target))) === expected) {
      return target;
    }

    yield* fs.remove(target, { force: true });
  }

  const bytes = yield* download(`${releaseBase}/${pins.tag}/${asset}`);

  yield* verifyDigest(bytes, expected, asset);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFile(target, bytes);
  yield* fs.chmod(target, 0o755);

  return target;
});

/**
 * Scans `bun.lock` in `options.dir` (default the repository root) with the pinned OSV-Scanner and
 * returns its exit code. The child sees only `PATH` and `HOME`.
 */
export const scan = Effect.fn("advisories.license")(function* scan(options: Options) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));

  const pins = yield* parsePins(
    yield* fs.readFileString(path.join(root, "tools/advisories/osv-scanner.pins.txt")),
  );

  const binary = yield* ensureBinary(root, pins, yield* hostAsset(process.platform, process.arch));
  const env = { HOME: yield* Config.String("HOME"), PATH: yield* Config.String("PATH") };

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          binary,
          [
            "scan",
            "source",
            `--config=${path.join(root, "tools/advisories/osv-scanner.toml")}`,
            "--lockfile=bun.lock",
            licensesFlag(options.allow ?? ALLOWED_LICENSES),
          ],
          {
            cwd: path.resolve(options.dir ?? root),
            env,
            extendEnv: false,
            stderr: "inherit",
            stdout: "inherit",
          },
        ),
      );

      return yield* handle.exitCode;
    }),
  );
});

const runtimeLayer = Layer.mergeAll(BunServices.layer, BunCrypto.layerDigest, BunHttpClient.layer);

if (import.meta.main) {
  BunRuntime.runMain(
    parseOptions(process.argv.slice(2)).pipe(
      Effect.flatMap(scan),
      Effect.flatMap((code) =>
        Effect.sync(() => {
          process.exitCode = code;
        }),
      ),
      Effect.provide(runtimeLayer),
    ),
  );
}
