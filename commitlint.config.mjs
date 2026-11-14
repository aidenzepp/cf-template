import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

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
 * The release-please subject: `release X.Y.Z`, with an optional prerelease suffix.
 */
const releaseSubject = /^release \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * The scopes any commit may use, beside the workspace directory names.
 */
const fixedScopes = ["tools", "docs", "deps"];

/**
 * Decodes the root `package.json` text into its `workspaces` globs.
 */
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ workspaces: Schema.Array(Schema.String) })),
);

/**
 * Whether a path is an existing directory.
 *
 * @param {string} candidate The path to test.
 * @returns {boolean} True when the path is a directory.
 */
const isDirectory = (candidate) =>
  statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * The workspace directory names: the root `package.json` `workspaces` globs expanded, `apps/*`
 * into each directory under `apps`, a literal such as `infra` into itself. Read from the working
 * directory at load time, so a new workspace is a valid scope without a config edit.
 *
 * @returns {string[]} The workspace directory names.
 */
const workspaceScopes = () => {
  const { workspaces } = decodeManifest(readFileSync("package.json", "utf-8"));

  return workspaces.flatMap((glob) => {
    if (!glob.endsWith("/*")) {
      return isDirectory(glob) ? [path.basename(glob)] : [];
    }

    const parent = glob.slice(0, -2);

    return isDirectory(parent)
      ? readdirSync(parent).filter((name) => isDirectory(path.join(parent, name)))
      : [];
  });
};

/**
 * Repository commit rules on top of `@commitlint/config-conventional`: the type list, the scope
 * list (the workspace directory names, read at load time, plus `tools`, `docs` and `deps`, and
 * `main` only for `chore(main): release X.Y.Z`), and no `Co-Authored-By:` trailer.
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
        /**
         * The scope is a workspace name or a fixed scope, except that `chore(main): release X.Y.Z`
         * (the release-please title) is admitted as one explicit form; no other `main` scope is.
         *
         * @param {{ type?: string | null; scope?: string | null; subject?: string | null }} parsed
         *   The parsed commit.
         */
        "scope-allowed": (parsed) => {
          const { scope, subject, type } = parsed;

          const allowed =
            scope === null ||
            scope === undefined ||
            [...workspaceScopes(), ...fixedScopes].includes(scope) ||
            (scope === "main" && type === "chore" && releaseSubject.test(subject ?? ""));

          return [
            allowed,
            `scope must be one of: ${[...workspaceScopes(), ...fixedScopes].join(", ")}`,
          ];
        },
      },
    },
  ],
  rules: {
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "header-shape": [2, "always"],
    "no-co-authored-by": [2, "always"],
    "scope-allowed": [2, "always"],
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "refactor", "test", "chore", "build", "ci", "perf", "revert"],
    ],
  },
};
