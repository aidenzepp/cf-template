import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Jsonc } from "effect/encoding";

const Specs = Schema.optional(Schema.Record(Schema.String, Schema.String));

const Manifest = Schema.Struct({
  dependencies: Specs,
  devDependencies: Specs,
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  peerDependencies: Specs,
  workspaces: Schema.optional(Schema.Array(Schema.String)),
});

// A lock entry starts with its `name@version` id; the rest (resolution, metadata, hash) is not read.
const Lock = Schema.Struct({
  packages: Schema.Record(
    Schema.String,
    Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Unknown]),
  ),
});

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

const decodeLock = Schema.decodeUnknownEffect(Lock);

const isString = Schema.is(Schema.String);

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

// bun.lock is JSONC with trailing commas, which Effect's Jsonc parser rejects; dropping each comma
// that precedes a closing bracket leaves valid JSONC (the lock has no such text inside a string).
const trailingComma = /,(?=\s*[}\]])/gu;

const parseLock = (text: string) =>
  Effect.fromResult(Jsonc.parse(text.replaceAll(trailingComma, "")));

/**
 * Reads the root manifest, the lock and every workspace manifest through the platform file system.
 * A workspace pattern `dir/*` names each subdirectory of `dir` that holds a package.json; any other
 * pattern names a directory directly.
 */
const load = Effect.gen(function* loadWorkspace() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const read = (relative: string) => fs.readFileString(path.join(root, relative));
  const readManifest = (relative: string) => Effect.flatMap(read(relative), decodeManifest);
  const rootManifest = yield* readManifest("package.json");
  const lock = yield* Effect.flatMap(Effect.flatMap(read("bun.lock"), parseLock), decodeLock);

  const directories = yield* Effect.all(
    (rootManifest.workspaces ?? []).map((pattern) =>
      pattern.endsWith("/*")
        ? Effect.map(fs.readDirectory(path.join(root, pattern.slice(0, -2))), (names) =>
            names.map((name) => `${pattern.slice(0, -2)}/${name}`),
          )
        : Effect.succeed([pattern]),
    ),
  );

  const candidates = ["", ...directories.flat()].map((directory) =>
    directory === "" ? "package.json" : `${directory}/package.json`,
  );

  const present = yield* Effect.all(
    candidates.map((relative) => fs.exists(path.join(root, relative))),
  );

  const manifests = yield* Effect.all(
    candidates
      .flatMap((relative, index) => (present[index] ? [relative] : []))
      .map((relative) =>
        Effect.map(readManifest(relative), (manifest) => ({ manifest, path: relative })),
      ),
  );

  return { lock, manifests, rootManifest };
}).pipe(Effect.provide(BunServices.layer));

/**
 * One installed package: `key` is the lock key, `name` its package name, `version` its resolved
 * version.
 */
interface Resolved {
  id: string;
  key: string;
  name: string;
  version: string;
}

// A key `a/b` is a second resolution of `b` nested under `a`; the package name is its last segment.
const lastPackageName = /(?<name>@[^/]+\/[^/]+|[^/@][^/]*)$/u;

const resolveLock = (lock: typeof Lock.Type): Array<Resolved> =>
  Object.entries(lock.packages).map(([key, [id]]) => ({
    id,
    key,
    name: lastPackageName.exec(key)?.groups?.name ?? key,
    version: id.slice(id.indexOf("@", 1) + 1),
  }));

const versionsOf = (
  resolved: Array<Resolved>,
  matches: (name: string) => boolean,
): Array<string> => [
  ...new Set(resolved.flatMap(({ name, version }) => (matches(name) ? [version] : []))),
];

const singletons = [
  "effect",
  "vitest",
  "vite",
  "typescript",
  "drizzle-orm",
  "better-auth",
  "react",
  "react-dom",
  "tailwindcss",
  "@cloudflare/workers-types",
];

const lockstepFamilies = {
  // @alchemy.run/sigil is versioned off the Alchemy release train (0.1.0-alpha.1).
  alchemy: (name: string) =>
    name === "alchemy" || (name.startsWith("@alchemy.run/") && name !== "@alchemy.run/sigil"),
  // @better-auth/utils is versioned on its own line (0.5.1) and better-auth@1.7.19 depends on it.
  "better-auth": (name: string) =>
    name === "better-auth" || (name.startsWith("@better-auth/") && name !== "@better-auth/utils"),
  // @effect/tsgo and its platform packages (@effect/tsgo-darwin-arm64, ...) share one version line
  // (0.67.7) apart from effect.
  effect: (name: string) =>
    name === "effect" ||
    (name.startsWith("@effect/") &&
      !name.startsWith("@effect/tsgo") &&
      name !== "@effect/language-service"),
  react: (name: string) => name === "react" || name === "react-dom",
  tailwindcss: (name: string) => name === "tailwindcss" || name === "@tailwindcss/vite",
};

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const specVersion = (spec: string): string => spec.replace(/^npm:.+@/u, "");

const isExact = (spec: string): boolean =>
  spec.startsWith("workspace:") || exactVersion.test(specVersion(spec));

/**
 * Every version string under `value`, with the dotted path that reaches it (overrides may nest).
 */
const specsOf = (value: Schema.Json, path: string): Array<[string, string]> => {
  if (isString(value)) {
    return [[path, value]];
  }

  if (isJsonObject(value)) {
    return Object.entries(value).flatMap(([key, inner]) => specsOf(inner, `${path}.${key}`));
  }

  return [];
};

const manifestSpecs = (
  manifests: ReadonlyArray<{ manifest: typeof Manifest.Type; path: string }>,
) =>
  manifests.flatMap(({ manifest, path }) =>
    (
      [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
        "overrides",
      ] as const
    ).flatMap((field) => specsOf(manifest[field] ?? {}, `${path}:${field}`)),
  );

describe("singletons", () => {
  for (const name of singletons) {
    it.effect(`${name} resolves to at most one version`, () =>
      Effect.gen(function* singleton() {
        const { lock } = yield* load;

        expect(
          versionsOf(resolveLock(lock), (candidate) => candidate === name).length,
        ).toBeLessThanOrEqual(1);
      }),
    );
  }
});

describe("Vite+", () => {
  it.effect("vite-plus, the vite alias and overrides.vite name one version", () =>
    Effect.gen(function* vitePlus() {
      const { devDependencies, overrides } = (yield* load).rootManifest;
      const overrideVite = overrides?.vite;

      expect([
        ...new Set([
          devDependencies?.["vite-plus"],
          specVersion(devDependencies?.vite ?? ""),
          isString(overrideVite) ? specVersion(overrideVite) : undefined,
        ]),
      ]).toHaveLength(1);
    }),
  );
});

describe("lockstep families", () => {
  for (const [family, matches] of Object.entries(lockstepFamilies)) {
    it.effect(`${family} resolves to one version`, () =>
      Effect.gen(function* lockstep() {
        const { lock } = yield* load;

        expect(versionsOf(resolveLock(lock), matches).length).toBeLessThanOrEqual(1);
      }),
    );
  }
});

describe("package.json versions", () => {
  it.effect("no version is a range, a tag or empty", () =>
    Effect.gen(function* exactPins() {
      const { manifests } = yield* load;

      expect(
        manifestSpecs(manifests)
          .filter(([, spec]) => !isExact(spec))
          .map(([path]) => path),
      ).toStrictEqual([]);
    }),
  );
});

describe("bun.lock sources", () => {
  it.effect("every resolved package comes from the npm registry", () =>
    Effect.gen(function* registrySources() {
      const { lock } = yield* load;

      const offenders = resolveLock(lock).flatMap(({ id, key, version }) => {
        const isWorkspace = version.startsWith("workspace:");
        const isViteAlias = key === "vite" && id.startsWith("@voidzero-dev/vite-plus-core@");

        return isWorkspace || isViteAlias || exactVersion.test(version) ? [] : [key];
      });

      expect(offenders).toStrictEqual([]);
    }),
  );
});
