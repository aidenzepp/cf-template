import { runMessage, runNames } from "./restricted-properties.ts";

/**
 * One `paths` entry of `no-restricted-imports`: a module, optionally narrowed to named imports.
 */
interface RestrictedPath {
  importNames?: Array<string>;
  message?: string;
  name: string;
}

/**
 * One `patterns` entry of `no-restricted-imports`: gitignore-style module globs.
 */
interface RestrictedPattern {
  group: Array<string>;
  message?: string;
}

/**
 * The import ban every `no-restricted-imports` override repeats, because the rule replaces rather
 * than merges its options per matching override: the run family, from both Effect entry points.
 */
export const basePaths: ReadonlyArray<RestrictedPath> = ["effect/Effect", "effect"].map((name) => ({
  importNames: [...runNames],
  message: runMessage,
  name,
}));

/**
 * The message of the two data-fetching library bans: the mechanism of the registry row.
 */
const serverDataMessage =
  "use Atom.fn, ApiClient.query and route loaders (docs/capabilities.md, Server data, async UI and mutation state)";

/**
 * The libraries that would add a second mechanism for a registry concern, each named with the row
 * that owns it (`docs/capabilities.md`). Every override repeats them, runtime boundaries included.
 */
export const libraryPaths: ReadonlyArray<RestrictedPath> = [
  { message: "use TanStack Form (docs/capabilities.md, Forms)", name: "react-hook-form" },
  { message: "use TanStack Form (docs/capabilities.md, Forms)", name: "formik" },
  {
    message:
      "use Effect Schema, with Schema.toStandardSchemaV1 for forms (docs/capabilities.md, Forms)",
    name: "zod",
  },
  {
    message: "use ScriptOnce and useSyncExternalStore (docs/capabilities.md, Theme)",
    name: "next-themes",
  },
  { message: serverDataMessage, name: "swr" },
  {
    message: `${serverDataMessage}; TanStack Query is rejected (C27)`,
    name: "@tanstack/react-query",
  },
];

/**
 * The `@hookform/*` resolvers of the rejected form library.
 */
export const libraryPatterns: ReadonlyArray<RestrictedPattern> = [
  { group: ["@hookform/*"], message: "use TanStack Form (docs/capabilities.md, Forms)" },
];

/**
 * Source reads the platform through `@effect/platform-bun`, never a `node:` module. A lifted file
 * names the gap it fills.
 */
export const nodeBuiltins: RestrictedPattern = {
  group: ["node:*"],
  message:
    "use the @effect/platform-bun services, never node:* (docs/capabilities.md, Platform APIs)",
};

/**
 * Builds one `lint.overrides` entry that restricts imports for `files`, prepending `basePaths` so
 * no scoped override silently drops the base ban. Only a runtime boundary passes `base: false`; the
 * library bans stay either way.
 */
export const restrictImports = (
  files: ReadonlyArray<string>,
  restrictions: {
    base?: boolean;
    paths?: ReadonlyArray<RestrictedPath>;
    patterns?: ReadonlyArray<RestrictedPattern>;
  },
) => {
  const rule: ["error", { paths: Array<RestrictedPath>; patterns: Array<RestrictedPattern> }] = [
    "error",
    {
      paths: [
        ...(restrictions.base === false ? [] : basePaths),
        ...libraryPaths,
        ...(restrictions.paths ?? []),
      ],
      patterns: [...libraryPatterns, ...(restrictions.patterns ?? [])],
    },
  ];

  return { files: [...files], rules: { "no-restricted-imports": rule } };
};
