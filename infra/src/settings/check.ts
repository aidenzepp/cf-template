import { Array as Arr, Console, Effect, Order, Schema } from "effect";
import { resolveStackName } from "../stack-name.ts";
import { declarationPlan, reviewerAppId } from "./declare.ts";
import type { DeclarationPlan } from "./declare.ts";
import { getJson, guardAdmin, refuseAmbientCredentials, resolveRepository } from "./repository.ts";
import type { GuardedRepository } from "./repository.ts";
import { CODE_SCANNING_RULESET } from "./rest-labels.ts";
import { detectTier } from "./tier.ts";

/**
 * The failure of a `--check` that found at least one difference. It carries the count, never the
 * lines, which were already printed.
 */
export class DriftError extends Schema.TaggedError<DriftError>()("DriftError", {
  differences: Schema.Number,
  message: Schema.String,
}) {}

/**
 * The secrets whose presence gates `CLOUDFLARE_DEPLOYS`: the two Cloudflare repository secrets.
 * `CLOUDFLARE_API_TOKEN` is settled; the second name, `CLOUDFLARE_ACCOUNT_ID`, is provisional
 * until I-42 defines the secrets in `docs/architecture.md`, and changes here when it does.
 */
const CLOUDFLARE_SECRETS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

/**
 * GitHub's page size and the page cap of {@link listAll}; the cap stops a server that ignores
 * `page` from looping.
 */
const PER_PAGE = 100;

const MAX_PAGES = 10;

/**
 * Anything GitHub lists by name.
 */
const Named = Schema.Struct({ name: Schema.String });

/**
 * The merge fields of `GET /repos/{owner}/{repo}` the declaration governs.
 */
const RepositoryFields = Schema.Struct({
  allow_auto_merge: Schema.optional(Schema.Boolean),
  allow_merge_commit: Schema.optional(Schema.Boolean),
  allow_rebase_merge: Schema.optional(Schema.Boolean),
  allow_squash_merge: Schema.optional(Schema.Boolean),
  delete_branch_on_merge: Schema.optional(Schema.Boolean),
});

/**
 * The rules of `GET /repos/{owner}/{repo}/rulesets/{id}` the declaration governs: the allowed
 * merge methods and the required status check contexts.
 */
const RulesetDetail = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      parameters: Schema.optional(
        Schema.Struct({
          allowed_merge_methods: Schema.optional(Schema.Array(Schema.String)),
          required_status_checks: Schema.optional(
            Schema.Array(Schema.Struct({ context: Schema.String })),
          ),
        }),
      ),
      type: Schema.String,
    }),
  ),
});

/**
 * Read every page of a GitHub list, `PER_PAGE` at a time, until a page comes back short.
 *
 * @param read - Reads one page, numbered from 1.
 * @returns The concatenated pages.
 */
const listAll = <A, E, R>(read: (page: number) => Effect.Effect<ReadonlyArray<A>, E, R>) =>
  Effect.gen(function* listPages() {
    const all: Array<A> = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = yield* read(page);
      all.push(...batch);

      if (batch.length < PER_PAGE) {
        break;
      }
    }

    return all;
  });

/**
 * Compare a live name list with a declared one: `UNDECLARED` for each live name nothing declares,
 * `MISSING` for each declared name that is not live. Nothing is ever deleted.
 *
 * @param kind - `ruleset`, `environment` or `label`.
 * @param live - The names GitHub lists.
 * @param declared - The names the declaration (or the program) owns.
 * @param required - The subset of `declared` that must exist.
 * @returns One line per difference.
 */
const compareNames = (
  kind: string,
  live: ReadonlyArray<string>,
  declared: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
) => [
  ...live.flatMap((name) => (declared.includes(name) ? [] : [`UNDECLARED ${kind} ${name}`])),
  ...required.flatMap((name) => (live.includes(name) ? [] : [`MISSING ${kind} ${name}`])),
];

/**
 * Join names in a stable order, so two lists compare equal regardless of GitHub's ordering.
 *
 * @param values - The names.
 * @returns The sorted, comma-joined names.
 */
const sorted = (values: ReadonlyArray<string>) => Arr.sort(values, Order.String).join(",");

/**
 * One `MISMATCH` line when two values differ.
 *
 * @param name - The setting or variable.
 * @param live - The live value.
 * @param expected - The detected or declared value.
 * @param word - `detected` for tier values, `declared` for declared ones.
 * @returns The line, or none when the values are equal.
 */
const mismatch = (name: string, live: string, expected: string, word = "detected") =>
  live === expected ? [] : [`MISMATCH ${name}: live ${live}, ${word} ${expected}`];

/**
 * Compare the live `main` ruleset with the declared one: merge methods and required contexts.
 *
 * @param path - The `/repos/{owner}/{repo}` path.
 * @param plan - The declaration plan.
 * @returns One line per difference, including a missing or undeclared ruleset.
 */
const rulesetLines = Effect.fn("rulesetLines")(function* rulesetLines(
  path: string,
  plan: DeclarationPlan,
) {
  const live = yield* listAll((page) =>
    getJson(
      `${path}/rulesets?includes_parents=false&per_page=${PER_PAGE}&page=${page}`,
      Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
    ),
  );

  const names = plan.ruleset.map((ruleset) => ruleset.name);

  const lines = compareNames(
    "ruleset",
    live.map((ruleset) => ruleset.name),
    [...names, CODE_SCANNING_RULESET.name],
    names,
  );

  const detailed = yield* Effect.all(
    plan.ruleset.map((declared) =>
      Effect.gen(function* compareRuleset() {
        const found = live.find((ruleset) => ruleset.name === declared.name);

        if (found === undefined) {
          return [];
        }

        const { rules } = yield* getJson(`${path}/rulesets/${found.id}`, RulesetDetail);
        const parameters = rules.map((rule) => rule.parameters);

        return [
          ...mismatch(
            `${declared.name} ruleset merge methods`,
            sorted(parameters.flatMap((entry) => entry?.allowed_merge_methods ?? [])),
            sorted(declared.pullRequest?.allowedMergeMethods ?? []),
            "declared",
          ),
          ...mismatch(
            `${declared.name} ruleset required checks`,
            sorted(
              parameters.flatMap((entry) =>
                (entry?.required_status_checks ?? []).map((check) => check.context),
              ),
            ),
            sorted((declared.requiredStatusChecks?.checks ?? []).map((check) => check.context)),
            "declared",
          ),
        ];
      }),
    ),
  );

  return [...lines, ...detailed.flat()];
});

/**
 * Compare the live variables with the tier the program detected.
 *
 * Each tier variable must equal the detected value (`unset` when absent). `CLOUDFLARE_DEPLOYS` may
 * be `true` only while both Cloudflare secrets exist. `STACK_NAME`, when present, must equal the
 * derivation of `resolveStackName`.
 *
 * @param live - The live variables by name.
 * @param plan - The declaration plan, whose variables are the detected tier values.
 * @param secrets - The names of the repository's secrets.
 * @returns One line per difference.
 */
const variableLines = Effect.fn("variableLines")(function* variableLines(
  live: ReadonlyMap<string, string>,
  plan: DeclarationPlan,
  secrets: ReadonlyArray<string>,
) {
  const tier = plan.variables.flatMap(({ name, value }) =>
    mismatch(name, live.get(name) ?? "unset", value),
  );

  const deploys =
    live.get("CLOUDFLARE_DEPLOYS") === "true" &&
    !CLOUDFLARE_SECRETS.every((name) => secrets.includes(name))
      ? ["MISMATCH CLOUDFLARE_DEPLOYS: live true, detected false"]
      : [];

  const pinned = live.get("STACK_NAME");

  const stack =
    pinned === undefined
      ? []
      : yield* resolveStackName().pipe(
          Effect.map((derived) => mismatch("STACK_NAME", pinned, derived)),
          Effect.catch((error) =>
            Effect.succeed([
              `MISMATCH STACK_NAME: live ${pinned}, detected none: ${error.message}`,
            ]),
          ),
        );

  return [...tier, ...deploys, ...stack];
});

/**
 * Read live state with GETs only and list every difference from the declaration and the detected
 * tier: merge settings, the `main` ruleset, `UNDECLARED` rulesets, environments and labels,
 * missing declared resources, the tier variables, `CLOUDFLARE_DEPLOYS` and `STACK_NAME`.
 *
 * @param repository - The guarded repository.
 * @returns One line per difference; empty when live state matches.
 */
export const readDrift = Effect.fn("readDrift")(function* readDrift(repository: GuardedRepository) {
  const path = `/repos/${repository.owner}/${repository.name}`;

  const secrets = (yield* getJson(
    `${path}/actions/secrets`,
    Schema.Struct({ secrets: Schema.Array(Named) }),
  )).secrets.map(({ name }) => name);

  const tier = yield* detectTier(repository, secrets);
  const plan = declarationPlan(repository, tier, yield* reviewerAppId);
  const fields = yield* getJson(path, RepositoryFields);
  const props = plan.repository;

  const settings = [
    ["allow_squash_merge", fields.allow_squash_merge, props.allowSquashMerge],
    ["allow_merge_commit", fields.allow_merge_commit, props.allowMergeCommit],
    ["allow_rebase_merge", fields.allow_rebase_merge, props.allowRebaseMerge],
    ["delete_branch_on_merge", fields.delete_branch_on_merge, props.deleteBranchOnMerge],
    ["allow_auto_merge", fields.allow_auto_merge, props.allowAutoMerge],
  ].flatMap(([name, value, declared]) =>
    declared === undefined
      ? []
      : mismatch(String(name), String(value), String(declared), "declared"),
  );

  const rulesets = tier.capabilities.has("rulesets") ? yield* rulesetLines(path, plan) : [];

  const environments = tier.environments
    ? compareNames(
        "environment",
        (yield* getJson(
          `${path}/environments?per_page=${PER_PAGE}`,
          Schema.Struct({ environments: Schema.Array(Named) }),
        )).environments.map(({ name }) => name),
        plan.environments.map(({ name }) => name),
        plan.environments.map(({ name }) => name),
      )
    : [];

  const labels = compareNames(
    "label",
    (yield* listAll((page) =>
      getJson(`${path}/labels?per_page=${PER_PAGE}&page=${page}`, Schema.Array(Named)),
    )).map(({ name }) => name),
    plan.labels.map(({ name }) => name),
    plan.labels.map(({ name }) => name),
  );

  const variables = yield* listAll((page) =>
    getJson(
      `${path}/actions/variables?per_page=${PER_PAGE}&page=${page}`,
      Schema.Struct({
        variables: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
      }),
    ).pipe(Effect.map((body) => body.variables)),
  );

  const variable = yield* variableLines(
    new Map(variables.map(({ name, value }) => [name, value])),
    plan,
    secrets,
  );

  return [...settings, ...rulesets, ...environments, ...labels, ...variable];
});

/**
 * Print the differences of {@link readDrift}, one line each, then a summary line.
 *
 * @param repository - The guarded repository.
 * @param when - The summary prefix: `check`, `check before apply` or `check after apply`.
 * @returns The number of differences.
 */
export const reportDrift = Effect.fn("reportDrift")(function* reportDrift(
  repository: GuardedRepository,
  when: string,
) {
  const lines = yield* readDrift(repository);

  yield* Effect.forEach(lines, (line) => Console.log(line), { discard: true });
  yield* Console.log(`${when}: ${lines.length === 0 ? "clean" : `${lines.length} difference(s)`}`);

  return lines.length;
});

/**
 * Fail with a {@link DriftError} unless the count is zero.
 *
 * @param differences - The number of differences found.
 * @returns Nothing when clean.
 */
export const failOnDrift = (differences: number) =>
  differences === 0
    ? Effect.void
    : Effect.fail(
        new DriftError({
          differences,
          message: `${differences} difference(s) between live state and the declaration; see the lines above.`,
        }),
      );

/**
 * The standalone `--check`: refuse ambient credentials, resolve the repository, guard on admin
 * access, print every difference and fail when there is any. It never writes.
 *
 * @returns Nothing when live state is clean, else a {@link DriftError}.
 */
export const checkSettings = Effect.gen(function* checkRun() {
  yield* refuseAmbientCredentials();

  const { owner, repo } = yield* resolveRepository();
  const repository = yield* guardAdmin({ owner, repo });

  yield* failOnDrift(yield* reportDrift(repository, "check"));
});
