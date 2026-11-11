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
 * than merges its options per matching override. P4 adds the run-family entries.
 */
export const basePaths: readonly RestrictedPath[] = [];

/**
 * Builds one `lint.overrides` entry that restricts imports for `files`, always prepending
 * `basePaths` so no scoped override silently drops the base ban.
 */
export const restrictImports = (
  files: readonly string[],
  restrictions: {
    paths?: readonly RestrictedPath[];
    patterns?: readonly RestrictedPattern[];
  },
) => {
  const rule: ["error", { paths: RestrictedPath[]; patterns: RestrictedPattern[] }] = [
    "error",
    {
      paths: [...basePaths, ...(restrictions.paths ?? [])],
      patterns: [...(restrictions.patterns ?? [])],
    },
  ];

  return { files: [...files], rules: { "no-restricted-imports": rule } };
};
