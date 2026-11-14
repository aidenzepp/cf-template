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
 * The message of the raw-SQL import ban (registry row "Database access").
 */
const sqlMessage =
  "write the query with the Drizzle query builder, not the sql tag (docs/capabilities.md, Database access)";

/**
 * The raw-SQL `sql` tag: from the `drizzle-orm` root, and from the `drizzle-orm/sql` subpaths.
 * Carried by every override, even a runtime boundary; only `sql: false` lifts it.
 */
const sqlPaths: ReadonlyArray<RestrictedPath> = [
  { importNames: ["sql"], message: sqlMessage, name: "drizzle-orm" },
];

/**
 * The `drizzle-orm/sql` subpaths of the raw-SQL ban.
 */
export const sqlPatterns: ReadonlyArray<RestrictedPattern> = [
  { group: ["drizzle-orm/sql", "drizzle-orm/sql/*"], message: sqlMessage },
];

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
  {
    message: `${serverDataMessage}; rejected with TanStack Query (D8)`,
    name: "@tanstack/query-core",
  },
  {
    message: `${serverDataMessage}; rejected with TanStack Query (D8)`,
    name: "@tanstack/react-db",
  },
  {
    message:
      "final-form is not used (D8): the form mechanism is TanStack Form, adopted with the first form (#227)",
    name: "final-form",
  },
  {
    message:
      "xstate is deferred (D9) until a client flow has at least three states and a guard one atom cannot express, or the Effect bridge is stable on a stable XState major",
    name: "xstate",
  },
  {
    message:
      "@tanstack/react-table is deferred (D10, #228) until the first grid that sorts, filters or pages",
    name: "@tanstack/react-table",
  },
  {
    message:
      "@tanstack/react-virtual is deferred (D10, #229) until the first list that renders hundreds of rows",
    name: "@tanstack/react-virtual",
  },
  {
    message: "@tanstack/react-hotkeys is deferred (D10, #230) until the first keyboard shortcut",
    name: "@tanstack/react-hotkeys",
  },
];

/**
 * The block live Layers (#232): a Worker gets one only through its attach file, so no other
 * module imports `KnobsKvLive` or `BudgetGuardLive`. `restrictImports` carries it unless an
 * attach file passes `blockLayers: false`.
 */
const blockLayerPaths: ReadonlyArray<RestrictedPath> = [
  {
    importNames: ["KnobsKvLive"],
    message: "import a block's live Layer only in the app's attach file (#232)",
    name: "@workspace/knobs-kv/live",
  },
  {
    importNames: ["BudgetGuardLive"],
    message: "import a block's live Layer only in the app's attach file (#232)",
    name: "@workspace/budget-guard/live",
  },
];

/**
 * The `@hookform/*` resolvers of the rejected form library.
 */
export const libraryPatterns: ReadonlyArray<RestrictedPattern> = [
  { group: ["@hookform/*"], message: "use TanStack Form (docs/capabilities.md, Forms)" },
  {
    group: ["@conform-to/*"],
    message:
      "@conform-to is not used (D8): the form mechanism is TanStack Form, adopted with the first form (#227)",
  },
  {
    group: ["@stylexjs/*"],
    message: "StyleX is not used (D8): styling is Tailwind through stock components",
  },
  {
    group: ["@xstate/*"],
    message:
      "@xstate/* is deferred (D9) until a client flow has at least three states and a guard one atom cannot express, or the Effect bridge is stable on a stable XState major",
  },
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
 * library bans stay either way. The raw-SQL ban stays too unless an exception passes `sql: false`.
 */
export const restrictImports = (
  files: ReadonlyArray<string>,
  restrictions: {
    base?: boolean;
    blockLayers?: boolean;
    sql?: boolean;
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
        ...(restrictions.blockLayers === false ? [] : blockLayerPaths),
        ...(restrictions.sql === false ? [] : sqlPaths),
        ...(restrictions.paths ?? []),
      ],
      patterns: [
        ...libraryPatterns,
        ...(restrictions.sql === false ? [] : sqlPatterns),
        ...(restrictions.patterns ?? []),
      ],
    },
  ];

  return { files: [...files], rules: { "no-restricted-imports": rule } };
};
