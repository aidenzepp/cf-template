import { chmod, mkdir, rm } from "node:fs/promises";

/**
 * One pinned release archive: the digest it must hash to and the asset file to download.
 */
export interface PinEntry {
  readonly sha256: string;
  readonly assetFile: string;
}

/**
 * The parsed contents of `tools/supdoc/pin.txt`: the release tag and one entry per target.
 */
export interface Pin {
  readonly tag: string;
  readonly targets: ReadonlyMap<string, PinEntry>;
}

const releaseBase = "https://github.com/aidenzepp/supdoc/releases/download";

const targetLine = /^(?<target>\S+) (?<sha256>[0-9a-f]{64}) (?<assetFile>\S+)$/u;

const tagLine = /^tag (?<tag>\S+)$/u;

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
 * Parse the pin file text. The first line is `tag <tag>`; every other line is
 * `<target> <sha256> <asset-file>`. A line that breaks the grammar, or a text with no
 * `tag` line, throws naming the line number and the missing field.
 */
export const parsePin = (text: string): Pin => {
  const lines = text
    .split("\n")
    .filter((line, index, all) => line !== "" || index < all.length - 1);

  const [first = "", ...rest] = lines;
  const tag = tagLine.exec(first)?.groups?.tag;

  if (tag === undefined) {
    throw new Error(`pin line 1: missing field "tag"; expected "tag <tag>", got "${first}".`);
  }

  const targets = new Map<string, PinEntry>();

  for (const [offset, line] of rest.entries()) {
    const match = targetLine.exec(line);

    if (match === null) {
      const fields = line.split(" ");
      const missing = ["target", "sha256", "asset-file"].filter((_, field) => !fields[field]);

      const detail =
        missing.length > 0 ? `missing field ${missing.join(", ")}` : "malformed sha256";

      throw new Error(
        `pin line ${offset + 2}: ${detail}; expected "<target> <sha256> <asset-file>", got "${line}".`,
      );
    }

    const [, target = "", sha256 = "", assetFile = ""] = match;

    targets.set(target, { assetFile, sha256 });
  }

  return { tag, targets };
};

/**
 * Hash bytes with SHA-256 and return the lowercase hex digest.
 */
const sha256Hex = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * Throw unless the SHA-256 digest of the bytes equals the expected hex string.
 */
export const verifyDigest = (bytes: Uint8Array, expected: string, assetFile = "archive"): void => {
  const actual = sha256Hex(bytes);

  if (actual !== expected) {
    throw new Error(
      `supdoc: digest mismatch for ${assetFile}: expected ${expected}, got ${actual}; the archive is refused.`,
    );
  }
};

/**
 * Resolve the release target for the host, or throw when no binary is published for it.
 */
const hostTarget = (): string => {
  const key = `${process.platform}-${process.arch}`;
  const target = hostTargets.get(key);

  if (target === undefined) {
    throw new Error(
      `supdoc has no release binary for ${key}; supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64.`,
    );
  }

  return target;
};

/**
 * Download the archive, throwing the pinned download message on any failure.
 */
const download = async (url: string): Promise<Uint8Array> => {
  const failure = (reason: string): Error =>
    new Error(
      `supdoc: download of ${url} failed (${reason}); bun install stops until the archive can be fetched and verified.`,
    );

  const [outcome] = await Promise.allSettled([fetch(url)]);

  if (outcome?.status !== "fulfilled") {
    throw failure(String(outcome?.reason));
  }

  const response = outcome.value;

  if (!response.ok) {
    throw failure(`HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
};

/**
 * Return a verified archive: the cached one when its digest matches (a mismatched cache
 * file is deleted), otherwise a fresh download that must match before it is cached.
 */
const verifiedArchive = async (
  url: string,
  cachePath: string,
  entry: PinEntry,
): Promise<Uint8Array> => {
  const cache = Bun.file(cachePath);

  if (await cache.exists()) {
    const cached = await cache.bytes();

    if (sha256Hex(cached) === entry.sha256) {
      return cached;
    }

    await rm(cachePath, { force: true });
  }

  const bytes = await download(url);

  verifyDigest(bytes, entry.sha256, entry.assetFile);
  await Bun.write(cachePath, bytes);

  return bytes;
};

/**
 * Install the pinned supdoc binary at `node_modules/.bin/supdoc`, verifying the archive
 * digest on every run, cache hits included.
 */
export const install = async (): Promise<void> => {
  const pin = parsePin(await Bun.file(new URL("pin.txt", import.meta.url)).text());
  const target = hostTarget();
  const entry = pin.targets.get(target);

  if (entry === undefined) {
    throw new Error(`pin.txt has no entry for target ${target}.`);
  }

  const version = pin.tag.replace(/^v/u, "");
  const cacheDir = `node_modules/.cache/supdoc/${version}`;

  const bytes = await verifiedArchive(
    `${releaseBase}/${pin.tag}/${entry.assetFile}`,
    `${cacheDir}/${entry.assetFile}`,
    entry,
  );

  const files = await new Bun.Archive(bytes).files("*/supdoc");
  const [binary] = files.values();

  if (binary === undefined) {
    throw new Error(`supdoc: ${entry.assetFile} contains no supdoc binary.`);
  }

  await mkdir("node_modules/.bin", { recursive: true });
  await Bun.write("node_modules/.bin/supdoc", binary);
  await chmod("node_modules/.bin/supdoc", 0o755);
};

if (import.meta.main) {
  await install();
}
