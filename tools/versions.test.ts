import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const root = fileURLToPath(new URL("..", import.meta.url));

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

const decodeManifest = Schema.decodeUnknownSync(Manifest);

const decodeLock = Schema.decodeUnknownSync(Lock);

const isString = Schema.is(Schema.String);

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

const readText = (path: string): Promise<string> => Bun.file(`${root}${path}`).text();

const readManifest = async (path: string) => decodeManifest(Bun.JSONC.parse(await readText(path)));

const rootManifest = await readManifest("package.json");

const lock = decodeLock(Bun.JSONC.parse(await readText("bun.lock")));

const manifestPaths = [
  "package.json",
  ...(rootManifest.workspaces ?? []).flatMap((pattern) => [
    ...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root }),
  ]),
];

const manifests = await Promise.all(
  manifestPaths.map(async (path) => ({ manifest: await readManifest(path), path })),
);

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

const resolved: Resolved[] = Object.entries(lock.packages).map(([key, [id]]) => ({
  id,
  key,
  name: lastPackageName.exec(key)?.groups?.name ?? key,
  version: id.slice(id.indexOf("@", 1) + 1),
}));

const versionsOf = (matches: (name: string) => boolean): string[] => [
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
  alchemy: (name: string) => name === "alchemy" || name.startsWith("@alchemy.run/"),
  "better-auth": (name: string) => name === "better-auth" || name.startsWith("@better-auth/"),
  effect: (name: string) =>
    name === "effect" ||
    (name.startsWith("@effect/") && name !== "@effect/tsgo" && name !== "@effect/language-service"),
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
const specsOf = (value: typeof Schema.Json.Type, path: string): [string, string][] => {
  if (isString(value)) {
    return [[path, value]];
  }

  if (isJsonObject(value)) {
    return Object.entries(value).flatMap(([key, inner]) => specsOf(inner, `${path}.${key}`));
  }

  return [];
};

const manifestSpecs = manifests.flatMap(({ manifest, path }) =>
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
  test.each(singletons)("%s resolves to at most one version", (name) => {
    expect(versionsOf((candidate) => candidate === name).length).toBeLessThanOrEqual(1);
  });
});

describe("Vite+", () => {
  test("vite-plus, the vite alias and overrides.vite name one version", () => {
    const { devDependencies, overrides } = rootManifest;
    const overrideVite = overrides?.vite;

    expect([
      ...new Set([
        devDependencies?.["vite-plus"],
        specVersion(devDependencies?.vite ?? ""),
        isString(overrideVite) ? specVersion(overrideVite) : undefined,
      ]),
    ]).toHaveLength(1);
  });
});

describe("lockstep families", () => {
  test.each(Object.entries(lockstepFamilies))("%s resolves to one version", (_family, matches) => {
    expect(versionsOf(matches).length).toBeLessThanOrEqual(1);
  });
});

describe("package.json versions", () => {
  test("no version is a range, a tag or empty", () => {
    expect(manifestSpecs.filter(([, spec]) => !isExact(spec)).map(([path]) => path)).toEqual([]);
  });
});

describe("bun.lock sources", () => {
  test("every resolved package comes from the npm registry", () => {
    const offenders = resolved.flatMap(({ id, key, version }) => {
      const isWorkspace = version.startsWith("workspace:");
      const isViteAlias = key === "vite" && id.startsWith("@voidzero-dev/vite-plus-core@");

      return isWorkspace || isViteAlias || exactVersion.test(version) ? [] : [key];
    });

    expect(offenders).toEqual([]);
  });
});
