import { Effect, FileSystem, Schema } from "effect";

/**
 * A removable slice of an app: the `paths` the pull-out deletes, except the `keep` modules that the
 * first of its two removal PRs leaves in place.
 */
export const Slice = Schema.Struct({
  keep: Schema.Array(Schema.String),
  name: Schema.String,
  paths: Schema.Array(Schema.String),
});

/**
 * A block whose code does not live in one package directory. A block with no entry is its package
 * directory.
 */
export const Block = Schema.Struct({
  name: Schema.String,
  paths: Schema.Array(Schema.String),
});

/**
 * The decoded `blocks.json`: the attach files, in which a unit appears only on attach lines, and
 * the units that are not a package directory.
 */
export const Manifest = Schema.Struct({
  attachFiles: Schema.Array(Schema.String),
  blocks: Schema.Array(Block),
  slices: Schema.Array(Slice),
});

/**
 * The manifest without the `slices` or `blocks` entry named `name`: the pull-out's own entry
 * removal.
 */
export const withoutUnit = (
  manifest: typeof Manifest.Type,
  name: string,
): typeof Manifest.Type => ({
  attachFiles: manifest.attachFiles,
  blocks: manifest.blocks.filter((block) => block.name !== name),
  slices: manifest.slices.filter((slice) => slice.name !== name),
});

/**
 * Decodes `text`, the contents of a `blocks.json`, failing in the error channel when the JSON or
 * its shape is wrong.
 */
export const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

/**
 * Reads and decodes the manifest at `file` through the platform file system.
 */
export const readManifest = Effect.fn("blocks.readManifest")(function* readManifest(file: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* decodeManifest(yield* fs.readFileString(file));
});
