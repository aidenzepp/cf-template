import kebabCasePaths from "./kebab-case-paths.mjs";
import noBuiltInTryCatch from "./no-built-in-try-catch.mjs";

/**
 * Enforces explicit Effect error boundaries and kebab-case directories.
 */
export default {
  meta: { name: "workspace" },
  rules: {
    "kebab-case-paths": kebabCasePaths,
    "no-built-in-try-catch": noBuiltInTryCatch,
  },
};
