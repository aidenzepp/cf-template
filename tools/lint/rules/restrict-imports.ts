import { runMessage, runNames } from "./restricted-properties.ts";

/**
 * One `paths` entry of `no-restricted-imports`: a module, optionally narrowed to named imports.
 */
interface RestrictedPath {
  importNames?: string[];
  message?: string;
  name: string;
}

/**
 * One `patterns` entry of `no-restricted-imports`: gitignore-style module globs.
 */
interface RestrictedPattern {
  group: string[];
  message?: string;
}

/**
 * The import ban every `no-restricted-imports` override repeats, because the rule replaces rather
 * than merges its options per matching override: the run family, from both Effect entry points.
 */
export const basePaths: readonly RestrictedPath[] = ["effect/Effect", "effect"].map((name) => ({
  importNames: [...runNames],
  message: runMessage,
  name,
}));

/**
 * Builds one `lint.overrides` entry that restricts imports for `files`, prepending `basePaths` so
 * no scoped override silently drops the base ban. Only a runtime boundary passes `base: false`.
 */
export const restrictImports = (
  files: readonly string[],
  restrictions: {
    base?: boolean;
    paths?: readonly RestrictedPath[];
    patterns?: readonly RestrictedPattern[];
  },
) => {
  const rule: ["error", { paths: RestrictedPath[]; patterns: RestrictedPattern[] }] = [
    "error",
    {
      paths: [...(restrictions.base === false ? [] : basePaths), ...(restrictions.paths ?? [])],
      patterns: [...(restrictions.patterns ?? [])],
    },
  ];

  return { files: [...files], rules: { "no-restricted-imports": rule } };
};
