/**
 * The import ban every `no-restricted-imports` override repeats, because the rule replaces rather
 * than merges its options per matching override. P4 adds the run-family entries.
 */
export const basePaths: readonly unknown[] = [];

/**
 * Builds one `lint.overrides` entry that restricts imports for `files`, always prepending
 * `basePaths` so no scoped override silently drops the base ban.
 */
export const restrictImports = (
  files: readonly string[],
  patterns: { paths?: readonly unknown[]; patterns?: readonly unknown[] },
) => ({
  files: [...files],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [...basePaths, ...(patterns.paths ?? [])],
        patterns: [...(patterns.patterns ?? [])],
      },
    ],
  },
});
