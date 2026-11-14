import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Path } from "effect";

/**
 * The three rules a runbook row can fail: a Tag outside the standard, a `verified` row with no run
 * cite, and an `unproven` row with no listed `I-NN` label.
 */
export type Rule = "untagged" | "unverified-cite" | "unlisted-label";

/**
 * One failing row: its 1-based line in the runbook, the rule it failed and why.
 */
export interface Finding {
  readonly line: number;
  readonly message: string;
  readonly rule: Rule;
}

/**
 * The tags the standard allows. Only `verified` binds a row to a run; `note` is a recorded fact.
 */
const tags = new Set(["verified", "unproven", "note"]);

/**
 * A run cite: `PR #<n> proof <m>`, or a commit sha of 7 to 40 hex characters with at least one
 * digit so a plain word is not read as a sha.
 */
const runCite = /\bPR #\d+ proof \d+\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/u;

/**
 * The cells of a table row, trimmed, split on every `|` that is not escaped as `\|`.
 */
const cells = (line: string): ReadonlyArray<string> =>
  line
    .trim()
    .replaceAll(/^\||\|$/gu, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim());

/**
 * Whether a table row is the `---` separator under a header.
 */
const isSeparator = (row: ReadonlyArray<string>): boolean =>
  row.every((cell) => /^:?-+:?$/u.test(cell));

/**
 * The first rule the five cells of one runbook row fail, or nothing when the row passes.
 */
const rowFinding = (
  row: ReadonlyArray<string>,
  labels: ReadonlySet<string>,
): Pick<Finding, "message" | "rule"> | undefined => {
  const tag = row.at(3) ?? "";
  const restsOn = row.at(4) ?? "";

  if (!tags.has(tag)) {
    return {
      message: `Tag "${tag}" is not verified, unproven or note; tag the row`,
      rule: "untagged",
    };
  }

  if (tag === "verified" && !runCite.test(restsOn)) {
    return {
      message: "a verified row needs a run cite in Rests on: PR #<n> proof <m> or a commit sha",
      rule: "unverified-cite",
    };
  }

  if (tag !== "unproven") {
    return undefined;
  }

  const named = restsOn.match(/\bI-\d+\b/gu) ?? [];
  const unlisted = named.filter((label) => !labels.has(label));

  if (named.length === 0) {
    return {
      message: "an unproven row must name the issue that proves it: an I-NN in Rests on",
      rule: "unlisted-label",
    };
  }

  return unlisted.length === 0
    ? undefined
    : {
        message: `${unlisted.join(", ")} not in the Build plan of docs/architecture.md; use a listed I-NN`,
        rule: "unlisted-label",
      };
};

/**
 * Checks every five-column table row under a `##` section of `runbook` against the tag standard.
 * `labels` is the set of `I-NN` labels the Build plan lists. Returns one finding per failing row.
 */
export const checkRunbook = (
  runbook: string,
  labels: ReadonlySet<string>,
): ReadonlyArray<Finding> => {
  const found: Array<Finding> = [];
  let inSection = false;

  for (const [index, text] of runbook.split("\n").entries()) {
    if (/^#\s/u.test(text)) {
      inSection = false;
    } else if (/^##\s/u.test(text)) {
      inSection = true;
    } else if (inSection && text.trimStart().startsWith("|")) {
      const row = cells(text);

      const failure =
        row.length === 5 && row[3] !== "Tag" && !isSeparator(row)
          ? rowFinding(row, labels)
          : undefined;

      if (failure !== undefined) {
        found.push({ line: index + 1, ...failure });
      }
    }
  }

  return found;
};

/**
 * Reads the `I-NN` labels from the `ID` column of the `## Build plan` table in `architecture`.
 * Other columns, such as filed issue numbers, are ignored.
 */
export const readBuildPlanLabels = (architecture: string): ReadonlySet<string> => {
  const labels = new Set<string>();
  let inPlan = false;
  let idColumn = -1;

  for (const text of architecture.split("\n")) {
    if (/^##\s/u.test(text)) {
      inPlan = /^##\s+Build plan\s*$/u.test(text);
      idColumn = -1;
    } else if (inPlan && text.trimStart().startsWith("|")) {
      const row = cells(text);

      if (idColumn === -1) {
        idColumn = row.indexOf("ID");
      } else {
        const label = row[idColumn];

        if (label !== undefined && /^I-\d+$/u.test(label)) {
          labels.add(label);
        }
      }
    }
  }

  return labels;
};

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runbook = process.argv.at(2);

      if (runbook === undefined) {
        yield* Console.error("usage: bun tools/docs/runbook-check.ts <runbook path>");
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });

        return;
      }

      const architecture = yield* path.fromFileUrl(
        new URL("../../docs/architecture.md", import.meta.url),
      );

      const lines = checkRunbook(
        yield* fs.readFileString(runbook),
        readBuildPlanLabels(yield* fs.readFileString(architecture)),
      ).map(({ line, message, rule }) => `${runbook}:${line}: ${rule}: ${message}`);

      yield* Effect.forEach(lines, (line) => Console.log(line), { discard: true });

      if (lines.length > 0) {
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
