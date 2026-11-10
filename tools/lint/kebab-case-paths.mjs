/**
 * @typedef {{
 *   report: (descriptor: {
 *     data: { segments: string };
 *     messageId: "kebabCasePath";
 *     node: unknown;
 *   }) => void;
 *   cwd: string;
 *   filename: string;
 * }} RuleContext
 */

/**
 * Reports whether a directory name is lowercase words joined by hyphens.
 * A leading, trailing, or repeated hyphen is rejected. Digits are allowed.
 * Filenames are left to `unicorn/filename-case`.
 *
 * @param {string} value One directory name.
 * @returns {boolean} Whether the directory name is kebab-case.
 */
const isKebabCase = (value) => {
  if (value.length === 0 || value.startsWith("-") || value.endsWith("-")) {
    return false;
  }

  let previousWasHyphen = false;

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isDigit = code >= 48 && code <= 57;
    const isLower = code >= 97 && code <= 122;

    if (character === "-") {
      if (previousWasHyphen) {
        return false;
      }

      previousWasHyphen = true;
      continue;
    }

    if (!isDigit && !isLower) {
      return false;
    }

    previousWasHyphen = false;
  }

  return true;
};

/**
 * Drops a trailing slash so a cwd prefix comparison does not depend on one.
 *
 * @param {string} value An absolute directory path.
 * @returns {string} The path without a trailing slash.
 */
const stripTrailingSlash = (value) => {
  if (value.endsWith("/") || value.endsWith("\\")) {
    return value.slice(0, -1);
  }

  return value;
};

/**
 * Expresses an absolute lint path relative to the lint process cwd.
 *
 * @param {string} cwd The directory Oxlint was started from.
 * @param {string} filename The absolute path of the file being linted.
 * @returns {string} The repository-relative path, or the original filename when it is outside
 *   `cwd`.
 */
const relativePath = (cwd, filename) => {
  const prefix = `${stripTrailingSlash(cwd)}/`;

  if (filename.startsWith(prefix)) {
    return filename.slice(prefix.length);
  }

  return filename;
};

/**
 * Returns directory names that are not kebab-case.
 * The filename is omitted because `unicorn/filename-case` already checks it.
 * `node_modules` and `dist` are ignored because those trees are not source names.
 *
 * @param {string} pathFromRoot Repository-relative path. Separators may be `/` or `\`.
 * @returns {string[]} The directory names to rename. An empty array means the directories are
 *   allowed.
 */
export const kebabCaseViolations = (pathFromRoot) => {
  if (pathFromRoot.length === 0 || pathFromRoot.startsWith("<")) {
    return [];
  }

  const segments = pathFromRoot
    .split("/")
    .flatMap((segment) => segment.split("\\"))
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  if (segments.includes("node_modules") || segments.includes("dist")) {
    return [];
  }

  segments.pop();

  return segments.filter((segment) => !isKebabCase(segment));
};

/**
 * Reports source directories that leave kebab-case.
 */
const kebabCasePaths = {
  /**
   * @param {RuleContext} context Oxlint rule context for the file being linted.
   * @returns {{ Program: (node: unknown) => void }} Visitor that checks the file path once.
   */
  create(context) {
    return {
      /**
       * @param {unknown} node The file's program root, used only to anchor the diagnostic.
       */
      Program(node) {
        const violations = kebabCaseViolations(relativePath(context.cwd, context.filename));

        if (violations.length === 0) {
          return;
        }

        context.report({
          data: { segments: violations.join(", ") },
          messageId: "kebabCasePath",
          node,
        });
      },
    };
  },
  meta: {
    docs: {
      description: "Require kebab-case directories.",
    },
    messages: {
      kebabCasePath:
        "Rename {{segments}} to kebab-case. Directory names must be lowercase words joined by hyphens.",
    },
    schema: [],
    type: "problem",
  },
};

export default kebabCasePaths;
