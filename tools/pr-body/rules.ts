import { Effect, Schema } from "effect";

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
 * The linking keywords the repository uses. `Closes` closes the issue when the pull request
 * merges; `Part of` and `Refs` link without closing (GitHub closes only on its own closing
 * keywords).
 */
type Keyword = "Closes" | "Part of" | "Refs";

/**
 * One issue reference with the keyword that introduces it.
 */
interface Link {
  readonly keyword: Keyword;
  readonly issue: number;
}

/**
 * Names the keyword a matched text spells, whatever its case, or nothing for any other text.
 */
const toKeyword = (text: string): Keyword | undefined => {
  switch (text.toLowerCase()) {
    case "closes": {
      return "Closes";
    }

    case "part of": {
      return "Part of";
    }

    case "refs": {
      return "Refs";
    }

    default: {
      return undefined;
    }
  }
};

/**
 * A fenced code block: three or more backticks or tildes, up to the same fence or the end of the
 * text when the fence never closes.
 */
const fencedBlock =
  /^ {0,3}(?<mark>`{3,}|~{3,})[^\n]*(?:(?:\n[\s\S]*?)?\n {0,3}\k<mark>[`~]*[ \t]*(?=\n|$)|[\s\S]*$)/gmu;

/**
 * An inline code span: a run of backticks to the next run of the same length, within one paragraph.
 */
const inlineCode = /(?<!`)(?<ticks>`+)(?!`)(?:(?!\n\n)[\s\S])+?(?<!`)\k<ticks>(?!`)/gu;

const linkPattern = /\b(?<keyword>Closes|Part of|Refs):? #(?<issue>\d+)\b/giu;

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

const noIssueLine = /^No issue:[ \t]+\S.*$/mu;

const disclosureLabel =
  /^\*\*AI disclosure:\*\*[ \t]*\n(?:[ \t]*\n)*(?<bullets>(?:- .*(?:\n|$))+)/mu;

/**
 * The block the disclosure rule expects, and the one `.github/pull_request_template.md` carries.
 */
export const expectedDisclosure = [
  "---",
  "**AI disclosure:**",
  "- **Provider:** <provider>",
  "- **Model:** <model>",
].join("\n");

/**
 * Removes what a reader does not see as prose: fenced code blocks and inline code spans, so a
 * keyword inside code never counts. Line endings are normalised first, because the GitHub web
 * form saves `\r\n`.
 *
 * @param body - The pull request body.
 * @returns The body without code.
 */
export const stripCode = (body: string): string =>
  body.replaceAll("\r\n", "\n").replaceAll(fencedBlock, "").replaceAll(inlineCode, "");

/**
 * Finds every `Closes`, `Part of` or `Refs` reference to an issue (`Closes #12`) outside code,
 * anywhere in the text. Keywords match without regard to case, as GitHub's do.
 *
 * @param body - The pull request body.
 * @returns The references in the order they appear.
 */
export const parseLinks = (body: string): ReadonlyArray<Link> =>
  [...stripCode(body).matchAll(linkPattern)].flatMap((match) => {
    const keyword = toKeyword(match.groups?.keyword ?? "");
    const issue = Number(match.groups?.issue);

    return keyword === undefined ? [] : [{ issue, keyword }];
  });

/**
 * Whether a line outside code is `No issue: <reason>` alone, the escape for a pull request that
 * answers no issue.
 *
 * @param body - The pull request body.
 * @returns True when such a line exists.
 */
export const hasNoIssue = (body: string): boolean => noIssueLine.test(stripCode(body));

/**
 * Whether the body carries the disclosure: a line `**AI disclosure:**` followed, after any blank
 * lines (the Markdown formatter adds one), by bullets that include a `- **Provider:** <value>` and
 * a `- **Model:** <value>`. A body written by more than one model repeats the pair.
 *
 * @param body - The pull request body.
 * @returns True when the label line and both bullets are present outside code.
 */
export const hasDisclosure = (body: string): boolean => {
  const bullets = disclosureLabel.exec(stripCode(body))?.groups?.bullets ?? "";

  return /^- \*\*Provider:\*\* \S/mu.test(bullets) && /^- \*\*Model:\*\* \S/mu.test(bullets);
};

/**
 * Whether the pull request comes from a bot the rules skip: a Release Please branch
 * (`release-please--branches--*`) or a Renovate branch (`renovate/*`), opened by an account of
 * type `Bot`. The author type, not a login, keeps a person's branch of the same name checked.
 *
 * @param pull - The head branch name and the author's GitHub account type (`User`, `Bot`).
 * @returns True when both the branch prefix and the author type match.
 */
export const isExempt = (pull: { readonly branch: string; readonly authorType: string }): boolean =>
  pull.authorType === "Bot" &&
  (pull.branch.startsWith("release-please--branches--") || pull.branch.startsWith("renovate/"));

const distinct = <A>(items: ReadonlyArray<A>): ReadonlyArray<A> =>
  items.filter((item, index) => items.indexOf(item) === index);

/**
 * Every rule the body breaks: a closing keyword other than `Closes`, a `Closes` list, one issue
 * under both a closing and a non-closing keyword, no issue link and no `No issue:` line, and no
 * disclosure.
 *
 * @param body - The pull request body.
 * @returns One sentence for each problem; empty when the body passes.
 */
export const problems = (body: string): ReadonlyArray<string> => {
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
const render = (found: ReadonlyArray<string>): string =>
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
 * @param pull - The body, the head branch name and the author's GitHub account type.
 * @returns Nothing on success.
 */
export const check = Effect.fn("prBody.check")(function* check(pull: {
  readonly body: string;
  readonly branch: string;
  readonly authorType: string;
}) {
  const found = isExempt(pull) ? [] : problems(pull.body);

  if (found.length === 0) {
    return yield* Effect.void;
  }

  return yield* new PrBodyError({ message: render(found), problems: found });
});
