import { Console, Effect, Schema } from "effect";
import { HttpClientResponse } from "effect/http";
import type { GuardedRepository } from "./repository.ts";
import { report, reportResponse, restClient, summarize } from "./rest.ts";
import type { Kind } from "./rest.ts";
import type { Tier } from "./tier.ts";

/**
 * The GitHub default labels the declaration does not name. `accessibility` is the seventh default
 * label on a new repository, observed on the probe repository.
 */
export const DEFAULT_LABELS = [
  "accessibility",
  "duplicate",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
] as const;

/**
 * The ruleset the program owns once an analysis exists: CodeQL results gate the default branch.
 * Body from "Create a repository ruleset", rule type `code_scanning`.
 */
export const CODE_SCANNING_RULESET = {
  conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
  enforcement: "active",
  name: "code-scanning",
  rules: [
    {
      parameters: {
        code_scanning_tools: [
          {
            alerts_threshold: "errors",
            security_alerts_threshold: "high_or_higher",
            tool: "CodeQL",
          },
        ],
      },
      type: "code_scanning",
    },
  ],
  target: "branch",
} as const;

const RULESET = "code-scanning-ruleset";

const Rulesets = Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String }));

/**
 * The most pages {@link ownRulesets} reads. GitHub allows 75 rulesets per repository, so one page
 * of 100 already holds them all; the cap only stops a server that ignores `page` from looping.
 */
const MAX_RULESET_PAGES = 10;

/**
 * List the repository's own rulesets, page by page, until a page comes back empty.
 *
 * "Get all repository rulesets" (`GET /repos/{owner}/{repo}/rulesets`) lists rulesets inherited
 * from the organization too unless `includes_parents=false`; an organization ruleset named
 * `code-scanning` must neither be mistaken for the repository's own nor hide it.
 *
 * @param send - The REST sender from `restClient`.
 * @param path - The `/repos/{owner}/{repo}/rulesets` path.
 * @returns The repository's own rulesets.
 */
const ownRulesets = Effect.fn("ownRulesets")(function* ownRulesets(
  send: Effect.Success<typeof restClient>,
  path: string,
) {
  const own: Array<(typeof Rulesets.Type)[number]> = [];

  for (let page = 1; page <= MAX_RULESET_PAGES; page += 1) {
    const response = yield* send("GET", `${path}?includes_parents=false&per_page=100&page=${page}`);
    const batch = yield* HttpClientResponse.schemaBodyJson(Rulesets)(response);

    if (batch.length === 0) {
      break;
    }

    own.push(...batch);
  }

  return own;
});

/**
 * Delete the default labels, and create or update the code-scanning ruleset, printing one outcome
 * line each.
 *
 * Label endpoint: "Delete a label" (`DELETE /repos/{owner}/{repo}/labels/{name}`); a 404 means the
 * label is already gone and counts as applied. Ruleset lookup lists only the repository's own
 * rulesets, paged. Ruleset endpoints: "Get a repository rulesets",
 * "Create a repository ruleset" and "Update a repository ruleset"; "List code scanning analyses
 * for a repository" decides whether an analysis exists. The ruleset step runs only when the tier
 * has `rulesets` and `GET .../code-scanning/analyses` finds an analysis on `main`; before the first
 * analysis GitHub answers 404 (or 403 without code scanning) and the run prints
 * `PENDING code-scanning ruleset: no analysis on main yet`, which is not counted. A failed call
 * never stops the rest; any failure ends the run in a `RestSettingsError` carrying the counts.
 *
 * @param repository - The guarded repository.
 * @param tier - The detected tier whose capabilities gate the ruleset.
 * @returns The counts, or a `RestSettingsError` when any call failed.
 */
export const applyRestLabels = Effect.fn("applyRestLabels")(function* applyRestLabels(
  repository: GuardedRepository,
  tier: Pick<Tier, "capabilities">,
) {
  const send = yield* restClient;
  const repo = `/repos/${repository.owner}/${repository.name}`;

  const deleted = yield* Effect.all(
    DEFAULT_LABELS.map((label) =>
      reportResponse(
        `delete-label ${label}`,
        send("DELETE", `${repo}/labels/${encodeURIComponent(label)}`),
        { goneIsApplied: true },
      ),
    ),
  );

  const upsert = Effect.gen(function* upsert() {
    const analyses = yield* send(
      "GET",
      `${repo}/code-scanning/analyses?ref=refs%2Fheads%2Fmain&per_page=1`,
    );

    if (![200, 403, 404].includes(analyses.status)) {
      return [yield* report("failed", RULESET, analyses.status)];
    }

    const present =
      analyses.status === 200 &&
      (yield* HttpClientResponse.schemaBodyJson(Schema.Array(Schema.Unknown))(analyses)).length > 0;

    if (!present) {
      return yield* Console.log("PENDING code-scanning ruleset: no analysis on main yet").pipe(
        Effect.as([]),
      );
    }

    const path = `${repo}/rulesets`;

    const found = (yield* ownRulesets(send, path)).find(
      (ruleset) => ruleset.name === CODE_SCANNING_RULESET.name,
    );

    return [
      yield* reportResponse(
        RULESET,
        found === undefined
          ? send("POST", path, CODE_SCANNING_RULESET)
          : send("PUT", `${path}/${found.id}`, CODE_SCANNING_RULESET),
        { gated: true },
      ),
    ];
  }).pipe(
    Effect.catch(() =>
      report("failed", RULESET, 0).pipe(Effect.map((kind): Array<Kind> => [kind])),
    ),
  );

  const ruleset = tier.capabilities.has("rulesets")
    ? yield* upsert
    : [yield* report("unavailable", RULESET, "tier")];

  return yield* summarize([...deleted, ...ruleset]);
});
