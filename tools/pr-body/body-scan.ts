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
 * The keyword each lowercased matched text spells.
 */
const KEYWORDS = new Map<string, Keyword>([
  ["closes", "Closes"],
  ["part of", "Part of"],
  ["refs", "Refs"],
]);

/**
 * Names the keyword a matched text spells, whatever its case, or nothing for any other text.
 */
const toKeyword = (text: string) => KEYWORDS.get(text.toLowerCase());

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

const noIssueLine = /^(?:[-*][ \t]+)?No issue:[ \t]+\S.*$/mu;

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
export const stripCode = (body: string) =>
  body.replaceAll("\r\n", "\n").replaceAll(fencedBlock, "").replaceAll(inlineCode, "");

/**
 * Finds every `Closes`, `Part of` or `Refs` reference to an issue (`Closes #12`) outside code,
 * anywhere in the text. Keywords match without regard to case, as GitHub's do.
 *
 * @param body - The pull request body.
 * @returns The references in the order they appear.
 */
export const parseLinks = (body: string) =>
  [...stripCode(body).matchAll(linkPattern)].flatMap((match) => {
    const keyword = toKeyword(match.groups?.keyword ?? "");
    const issue = Number(match.groups?.issue);

    return keyword === undefined ? [] : [{ issue, keyword } satisfies Link];
  });

/**
 * Whether a line outside code is `No issue: <reason>` alone, with or without a leading `- ` or
 * `* ` bullet marker, the escape for a pull request that answers no issue.
 *
 * @param body - The pull request body.
 * @returns True when such a line exists.
 */
export const hasNoIssue = (body: string) => noIssueLine.test(stripCode(body));

/**
 * Whether the body carries the disclosure: a line `**AI disclosure:**` followed, after any blank
 * lines (the Markdown formatter adds one), by bullets that include a `- **Provider:** <value>` and
 * a `- **Model:** <value>`. A body written by more than one model repeats the pair.
 *
 * @param body - The pull request body.
 * @returns True when the label line and both bullets are present outside code.
 */
export const hasDisclosure = (body: string) => {
  const bullets = disclosureLabel.exec(stripCode(body))?.groups?.bullets ?? "";

  return /^- \*\*Provider:\*\* \S/mu.test(bullets) && /^- \*\*Model:\*\* \S/mu.test(bullets);
};
