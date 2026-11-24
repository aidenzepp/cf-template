import { Effect, Schema } from "effect";
import {
  expectedDisclosure,
  hasDisclosure,
  hasNoIssue,
  parseLinks,
  stripCode,
} from "./body-scan.ts";

/**
 * The pull request body fails at least one rule; `problems` lists every one.
 */
export class PrBodyError extends Schema.TaggedError<
  PrBodyError,
  { readonly brand: unique symbol }
>()("PrBodyError", {
  message: Schema.String,
  problems: Schema.Array(Schema.String),
}) {}

/**
 * A GitHub closing keyword other than `Closes`: GitHub closes the issue on merge, but the
 * repository writes the closing form one way.
 */
const otherClosing =
  /\b(?<keyword>close|closed|fix|fixes|fixed|resolve|resolves|resolved):? #(?<issue>\d+)\b/giu;

/**
 * `Closes #1, #2`: GitHub closes only the first issue of the list.
 */
const closingList = /\bCloses:? #\d+\b(?:,| and| &)\s*#\d+/giu;

/**
 * The title Release Please gives its pull request: `chore(main): release X.Y.Z`, with an optional
 * prerelease suffix. It is the shape of `releaseSubject` in `commitlint.config.mjs` without the
 * ` (#N)` suffix, which squash merge appends after the title is written.
 */
const releaseTitle = /^chore\(main\): release \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * The account Renovate opens its pull requests as.
 */
const renovateLogin = "renovate[bot]";

/**
 * The facts about a pull request that decide whether the rules skip it.
 */
interface PullOrigin {
  readonly branch: string;
  readonly authorType: string;
  readonly authorLogin: string;
  readonly title: string;
}

/**
 * Whether the pull request is one a bot opens and the rules skip. A release pull request needs a
 * Release Please branch (`release-please--branches--*`), an author of type `Bot` and the title
 * `chore(main): release X.Y.Z`. A Renovate pull request needs a `renovate/*` branch, an author of
 * type `Bot` and the login `renovate[bot]`. The branch name is free for anyone to choose and every
 * GitHub App is a `Bot`, so a branch prefix and the author type alone would exempt any app that
 * names its branch that way; each form must match on every fact it lists, and anything else is
 * checked.
 *
 * @param pull - The head branch name, the author's GitHub account type (`User`, `Bot`) and login,
 *   and the pull request title.
 * @returns True when every fact of one of the two forms matches.
 */
export const isExempt = (pull: PullOrigin) =>
  pull.authorType === "Bot" &&
  ((pull.branch.startsWith("release-please--branches--") && releaseTitle.test(pull.title)) ||
    (pull.branch.startsWith("renovate/") && pull.authorLogin === renovateLogin));

const distinct = <A>(items: ReadonlyArray<A>) =>
  items.filter((item, index) => items.indexOf(item) === index);

/**
 * Every rule the body breaks: a closing keyword other than `Closes`, a `Closes` list, one issue
 * under both a closing and a non-closing keyword, no issue link and no `No issue:` line, and no
 * disclosure.
 *
 * @param body - The pull request body.
 * @returns One sentence for each problem; empty when the body passes.
 */
export const problems = (body: string) => {
  const prose = stripCode(body);
  const links = parseLinks(body);

  const closed = new Set(
    links.filter((link) => link.keyword === "Closes").map((link) => link.issue),
  );

  const split = distinct(
    links
      .filter((link) => link.keyword !== "Closes" && closed.has(link.issue))
      .map((link) => link.issue),
  );

  const other = distinct([...prose.matchAll(otherClosing)].map((match) => match[0]));

  const lists = distinct([...prose.matchAll(closingList)].map((match) => match[0]));

  return [
    ...other.map(
      (text) =>
        `\`${text}\` is a GitHub closing keyword other than \`Closes\`. Write \`Closes #N\` to close the issue, or \`Part of #N\` or \`Refs #N\` to leave it open.`,
    ),
    ...lists.map(
      (text) =>
        `\`${text}\` closes only the first issue. Write one keyword for each issue, such as \`Closes #1. Closes #2.\``,
    ),
    ...split.map(
      (issue) =>
        `#${issue} appears under \`Closes\` and under \`Part of\` or \`Refs\`. Keep one: \`Closes\` closes it on merge, the others leave it open.`,
    ),
    ...(links.length === 0 && !hasNoIssue(body)
      ? [
          "The body links no issue. Add `Closes #N`, `Part of #N` or `Refs #N` outside code, or a line `No issue: <reason>`.",
        ]
      : []),
    ...(hasDisclosure(body)
      ? []
      : [
          "The body has no AI disclosure. End it with a line `**AI disclosure:**` followed by `- **Provider:** <provider>` and `- **Model:** <model>` bullets.",
        ]),
  ];
};

/**
 * Renders the failure text: each problem, then the block the body needs.
 */
const render = (found: ReadonlyArray<string>) =>
  [
    "The pull request body does not pass:",
    ...found.map((problem) => `- ${problem}`),
    "",
    "Expected in the body, anywhere outside code: `Closes #<issue>.` (or `Part of #<issue>.` or `Refs #<issue>.`, or a line `No issue: <reason>`). Expected at its end:",
    "",
    expectedDisclosure,
  ].join("\n");

/**
 * Fails with every problem the body has, unless the pull request is exempt. The message names
 * each problem and shows the block the body needs.
 *
 * @param pull - The body, the head branch name, the title and the author's GitHub account type
 *   and login.
 * @returns Nothing on success.
 */
export const check = Effect.fn("prBody.check")(function* check(
  pull: PullOrigin & { readonly body: string },
) {
  const found = isExempt(pull) ? [] : problems(pull.body);

  if (found.length === 0) {
    return yield* Effect.void;
  }

  return yield* new PrBodyError({ message: render(found), problems: found });
});
