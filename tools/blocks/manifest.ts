import { Effect, FileSystem, Predicate, Schema } from "effect";

/**
 * A dependency a unit owns: the repository-relative path of a `package.json` (`package.json` for
 * the root) and the dependency's name there. The pull-out deletes it with the unit.
 */
const Dependency = Schema.Struct({
  manifest: Schema.String,
  name: Schema.String,
});

/**
 * A removable slice of an app: the `paths` the pull-out deletes, except the `keep` modules that the
 * first of its two removal PRs leaves in place.
 */
const Slice = Schema.Struct({
  dependencies: Schema.optional(Schema.Array(Dependency)),
  keep: Schema.Array(Schema.String),
  name: Schema.String,
  paths: Schema.Array(Schema.String),
});

/**
 * A block whose code does not live in one package directory. A block with no entry is its package
 * directory.
 */
const Block = Schema.Struct({
  dependencies: Schema.optional(Schema.Array(Dependency)),
  name: Schema.String,
  paths: Schema.Array(Schema.String),
});

/**
 * The fields of a `package.json`, as JSON values.
 */
const PackageManifest = Schema.Record(Schema.String, Schema.Json);

/**
 * Decodes the contents of a `package.json` into its fields.
 */
export const decodePackageManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PackageManifest),
);

/**
 * The `package.json` sections that hold dependency names.
 */
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * The messages for the `owned` dependencies that their manifest does not list. `manifests` maps a
 * repository-relative `package.json` path to its decoded fields; a manifest missing from it lists
 * nothing.
 */
export const missingDependencies = (
  owned: ReadonlyArray<typeof Dependency.Type>,
  manifests: ReadonlyMap<string, typeof PackageManifest.Type>,
): ReadonlyArray<string> =>
  owned.flatMap(({ manifest, name }) =>
    dependencySections.some((section) => {
      const listed = manifests.get(manifest)?.[section];

      return Predicate.isObject(listed) && name in listed;
    })
      ? []
      : [`blocks.json owns dependency ${name} but ${manifest} lists none`],
  );

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
