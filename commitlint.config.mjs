import isIgnored from "@commitlint/is-ignored";

/**
 * A `Co-Authored-By:` trailer line anywhere in the message, in any case.
 */
const trailer = /^Co-Authored-By:/imu;

/**
 * The header shape the repository accepts: `type(scope)?!?: subject` with at most one scope, which
 * holds none of the delimiters commitlint would split into several scopes.
 */
const header = /^[a-z]+(?:\([^(),/\\]+\))?!?: \S.*$/u;

/**
 * Repository commit rules on top of `@commitlint/config-conventional`: the type list, the scope
 * list (the workspace directory names plus `tools`, `docs` and `deps`), and no `Co-Authored-By:`
 * trailer.
 *
 * Three parts are not config alone. The `no-co-authored-by` rule is a local plugin, because
 * `trailer-exists` is case-sensitive and reads only the final trailer block. The `header-shape`
 * rule is a local plugin, because `scope-enum` accepts `feat(web,api):` and `feat():`. The
 * `ignores` entry keeps commitlint's default ignores (merge, revert, fixup, release versions) but
 * never ignores a message that carries the trailer, because a plugin rule does not run on an
 * ignored message.
 */
export default {
  defaultIgnores: false,
  extends: ["@commitlint/config-conventional"],
  ignores: [
    /**
     * @param {string} message The raw commit message.
     */
    (message) => !trailer.test(message) && isIgnored(message),
  ],
  plugins: [
    {
      rules: {
        /**
         * @param {{ header?: string | null }} parsed The parsed commit.
         */
        "header-shape": (parsed) => [
          header.test((parsed.header ?? "").trimEnd()),
          "header must be `type(scope)?: subject` with one scope",
        ],
        /**
         * @param {{ raw?: string }} parsed The parsed commit.
         */
        "no-co-authored-by": (parsed) => [
          !trailer.test(parsed.raw ?? ""),
          "Remove the `Co-Authored-By:` trailer. AI disclosure goes in the pull request body (see /pr-authoring); this repository does not record it in commits.",
        ],
      },
    },
  ],
  rules: {
    "header-shape": [2, "always"],
    "no-co-authored-by": [2, "always"],
    "scope-enum": [
      2,
      "always",
      [
        "auth",
        "web",
        "api",
        "ui",
        "contract",
        "budget-guard",
        "config",
        "knobs-kv",
        "db",
        "infra",
        "tools",
        "docs",
        "deps",
      ],
    ],
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "refactor", "test", "chore", "build", "ci", "perf", "revert"],
    ],
  },
};
