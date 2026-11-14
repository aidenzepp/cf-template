import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Alchemist from "alchemy/Alchemist";
import type { PlannedResource } from "alchemy/Events";
import {
  Array as Arr,
  Config,
  Console,
  Effect,
  FileSystem,
  Option,
  Order,
  Schema,
  Stdio,
} from "effect";
import { Digest } from "effect/crypto";
import { isStatefulType } from "../src/stateful-types.ts";

/**
 * The failure of the prod plan, with the message the workflow log shows. A failed run writes
 * neither `destructive` nor `fingerprint`.
 */
class PlanProdError extends Schema.TaggedError<PlanProdError, { readonly brand: unique symbol }>()(
  "PlanProdError",
  {
    message: Schema.String,
  },
) {}

/**
 * One binding row of a planned resource: the classifier reads only its `action`.
 */
const PlanBinding = Schema.Struct({
  action: Schema.Literals(["create", "update", "delete", "noop"]),
  sid: Schema.String,
});

/**
 * The fields of one Alchemy plan row the classifier, the fingerprint and the summary read. Every
 * other field of the row (`providerMode`, `fromProviderMode`, and any Alchemy adds) is ignored, so
 * a field the classifier does not use cannot fail the plan. `describeResource` in Alchemy's
 * `src/Plan.ts` writes `providerMode` and `fromProviderMode` as present keys holding `undefined`,
 * which Alchemy's own `PlannedResource` (`optionalKey`) rejects. An action outside this set fails
 * decoding rather than reaching the classifier.
 */
const PlanRowSchema = Schema.Struct({
  action: Schema.Literals(["create", "update", "adopted", "replace", "delete", "orphaned", "noop"]),
  bindings: Schema.Array(PlanBinding),
  fqn: Schema.String,
  logicalId: Schema.String,
  resourceType: Schema.String,
});

/**
 * One decoded plan row.
 */
type PlanRow = typeof PlanRowSchema.Type;

/**
 * The resource rows of a plan.
 */
const PlanRows = Schema.Array(PlanRowSchema);

/**
 * How one planned row weighs on the `prod` deploy (#44 items 3 and 9).
 */
type RowClass = "blocking" | "notice" | "info" | "noop";

/**
 * One planned row with its class and, where the classifier has one, the line the summary prints.
 */
export interface ClassifiedRow {
  readonly row: PlanRow;
  readonly class: RowClass;
  readonly note: Option.Option<string>;
}

/**
 * The verdict a classified plan gives the workflow.
 */
export interface Verdict {
  readonly destructive: boolean;
  readonly fingerprint: string;
  readonly rows: ReadonlyArray<ClassifiedRow>;
}

/**
 * The summary line of a D1 `replace` (#44 item 3). The plan row carries no name field, so the line
 * is printed for every D1 `replace`, explicitly named or not.
 */
export const D1_REPLACE_NOTE =
  "deletes the old database before creating the new one unless `retain`";

/**
 * The summary line of a `prod` plan whose rows are all `create`.
 */
export const ALL_CREATE_NOTE =
  "every row is `create`: prod has no baseline, so the first deploy waits for the owner";

/**
 * The summary line of a plan with no rows. A `prod` stack always plans at least one row, so an
 * empty plan means the plan did not read the stack; it is held like a destructive one. A plan whose
 * rows are all `noop` is the positive "no changes" answer.
 */
export const EMPTY_PLAN_NOTE =
  "the plan has no rows, so it says nothing about prod; held until the owner confirms it";

/**
 * The actions that remove or rebuild a resource.
 */
const DESTRUCTIVE_ACTIONS = new Set(["replace", "delete", "orphaned"]);

/**
 * The resource type of a Worker. A Worker hosts its Durable Object classes, and their storage has
 * no plan row of its own: a Worker replace or removal destroys it, and an update that drops a class
 * deletes that class through the script migration.
 */
const WORKER_TYPE = "Cloudflare.Worker";

/**
 * The summary line of a Worker `replace`, `delete` or `orphaned`.
 */
export const WORKER_REMOVED_NOTE = "destroys the storage of every Durable Object this Worker hosts";

/**
 * The summary line of a Worker `update` that removes a binding. A removed Durable Object binding
 * deletes its class; the row does not say which kind of binding it is, so every removal holds.
 */
export const BINDING_REMOVED_NOTE =
  "removes a binding; if it is a Durable Object binding, its class and storage are deleted";

/**
 * Classify one row on its own. A destructive action on a stateful type blocks, whatever
 * `deleteFirst` says (the row does not carry it), and so does one on a Worker, or a Worker update
 * that removes a binding, for the Durable Object storage the Worker hosts. The same actions on
 * another type, and `adopted`, are notices; `create` and `update` are info.
 *
 * @param row - One planned resource.
 * @returns The row with its class and note.
 */
const classifyRow = (row: PlanRow): ClassifiedRow => {
  if (row.resourceType === WORKER_TYPE) {
    if (DESTRUCTIVE_ACTIONS.has(row.action)) {
      return { class: "blocking", note: Option.some(WORKER_REMOVED_NOTE), row };
    }

    if (row.action === "update" && row.bindings.some((binding) => binding.action === "delete")) {
      return { class: "blocking", note: Option.some(BINDING_REMOVED_NOTE), row };
    }
  }

  if (DESTRUCTIVE_ACTIONS.has(row.action)) {
    if (!isStatefulType(row.resourceType)) {
      return { class: "notice", note: Option.none(), row };
    }

    const note =
      row.action === "replace" && row.resourceType === "Cloudflare.D1Database"
        ? Option.some(D1_REPLACE_NOTE)
        : Option.none();

    return { class: "blocking", note, row };
  }

  if (row.action === "adopted") {
    return { class: "notice", note: Option.none(), row };
  }

  return { class: row.action === "noop" ? "noop" : "info", note: Option.none(), row };
};

/**
 * Classify a `prod` plan. A plan with at least one row and every row `create` blocks as a whole,
 * since `prod` then has no baseline to compare against.
 *
 * @param rows - The decoded plan rows.
 * @returns One classified row per planned resource, in plan order.
 */
const classify = (rows: ReadonlyArray<PlanRow>): ReadonlyArray<ClassifiedRow> =>
  rows.length > 0 && rows.every((row) => row.action === "create")
    ? rows.map((row) => ({ class: "blocking", note: Option.some(ALL_CREATE_NOTE), row }))
    : rows.map(classifyRow);

/**
 * The digest of the blocking rows: `sha256` over their `fqn`, `resourceType` and `action`, one
 * tab-separated line per row, sorted, joined by newlines, hex-encoded.
 *
 * @param rows - The classified rows.
 * @returns The lowercase hex digest.
 */
const fingerprint = Effect.fn("planProd.fingerprint")(function* fingerprint(
  rows: ReadonlyArray<ClassifiedRow>,
) {
  const digest = yield* Digest.Digest;

  const lines = rows.flatMap(({ class: rowClass, row }) =>
    rowClass === "blocking" ? [`${row.fqn}\t${row.resourceType}\t${row.action}`] : [],
  );

  const sorted = Arr.sort(lines, Order.String);

  return yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(sorted.join("\n")));
}, Effect.provide(Digest.layerWebCrypto));

/**
 * The failure of a plan whose rows do not decode.
 *
 * @param error - The schema error.
 * @returns The plan failure naming it.
 */
const undecodable = (error: Schema.SchemaError) =>
  new PlanProdError({ message: `The plan rows do not decode: ${error.message}` });

/**
 * Decode the `resources` of a computed plan to the fields the classifier reads, so an unknown
 * action fails here rather than in the classifier.
 *
 * @param resources - The `resources` of an `Alchemist.plan` result.
 * @returns The rows, or a failure when a row lacks a read field or carries an unknown action.
 */
export const rowsOfPlan = (resources: ReadonlyArray<PlannedResource>) =>
  Schema.decodeEffect(PlanRows)(resources).pipe(Effect.mapError(undecodable));

/**
 * Decode a plan written as JSON text, as the fixtures are.
 *
 * @param text - A JSON array of planned resources.
 * @returns The rows, or a failure when the text is not a decodable plan.
 */
export const rowsOfJson = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(PlanRows))(text).pipe(Effect.mapError(undecodable));

/**
 * Classify decoded rows into the verdict.
 *
 * @param decoded - The decoded plan rows.
 * @returns The verdict.
 */
export const verdictOf = Effect.fn("planProd.verdictOf")(function* verdictOf(
  decoded: ReadonlyArray<PlanRow>,
) {
  const rows = classify(decoded);

  return {
    destructive: rows.length === 0 || rows.some((entry) => entry.class === "blocking"),
    fingerprint: yield* fingerprint(rows),
    rows,
  } satisfies Verdict;
});

/**
 * Render the summary: the verdict line, one table row per planned resource (`fqn`,
 * `resourceType`, `action`, `class`), then the classifier's notes. The job summary and the PR
 * comment both print this text.
 *
 * @param verdict - The classified plan.
 * @returns The Markdown summary.
 */
export const renderSummary = (verdict: Verdict): string => {
  const table = verdict.rows.map(
    ({ class: rowClass, row }) =>
      `| \`${row.fqn}\` | \`${row.resourceType}\` | ${row.action} | ${rowClass} |`,
  );

  const notes = verdict.rows.flatMap(({ note, row }) =>
    Option.match(note, {
      onNone: () => [],
      onSome: (text) => [`- \`${row.fqn}\` (${row.action}): ${text}`],
    }),
  );

  return [
    "### prod plan",
    "",
    `destructive=${String(verdict.destructive)}, fingerprint \`${verdict.fingerprint}\``,
    "",
    "| fqn | resourceType | action | class |",
    "| --- | --- | --- | --- |",
    ...table,
    ...(verdict.rows.length === 0 ? ["", `- ${EMPTY_PLAN_NOTE}`] : []),
    ...(notes.length > 0 ? ["", ...notes] : []),
    "",
  ].join("\n");
};

/**
 * Read `--fingerprint <digest>` from the arguments.
 *
 * @param args - The process arguments after the script path.
 * @returns The expected digest when the flag is given, or a failure on any other argument.
 */
const parseArgs = (args: ReadonlyArray<string>) => {
  if (args.length === 0) {
    return Effect.succeed(Option.none<string>());
  }

  const [flag, digest = "", ...extra] = args;

  return flag === "--fingerprint" && /^[0-9a-f]{64}$/u.test(digest) && extra.length === 0
    ? Effect.succeedSome(digest)
    : Effect.fail(
        new PlanProdError({
          message:
            "Usage: bun scripts/plan-prod.ts [--fingerprint <64-character lowercase sha256>].",
        }),
      );
};

/**
 * Refuse a recomputed plan whose fingerprint differs from the one `prod.yml` held.
 *
 * @param verdict - The recomputed verdict.
 * @param expected - The digest from `--fingerprint`, when given.
 * @returns The verdict, or a failure naming both digests.
 */
export const checkFingerprint = (verdict: Verdict, expected: Option.Option<string>) =>
  Option.isSome(expected) && expected.value !== verdict.fingerprint
    ? Effect.fail(
        new PlanProdError({
          message: `The prod plan changed since it was held: expected ${expected.value}, recomputed ${verdict.fingerprint}.`,
        }),
      )
    : Effect.succeed(verdict);

/**
 * Write the summary to `$GITHUB_STEP_SUMMARY` and both outputs to `$GITHUB_OUTPUT` in one append,
 * or print them when the variables are unset (a local run).
 *
 * @param verdict - The checked verdict.
 * @returns Nothing; fails when a file cannot be written.
 */
const report = Effect.fn("planProd.report")(function* report(verdict: Verdict) {
  const fs = yield* FileSystem.FileSystem;
  const summaryPath = yield* Config.option(Config.String("GITHUB_STEP_SUMMARY"));
  const outputPath = yield* Config.option(Config.String("GITHUB_OUTPUT"));
  const summary = renderSummary(verdict);
  const outputs = `destructive=${String(verdict.destructive)}\nfingerprint=${verdict.fingerprint}\n`;

  yield* Option.match(summaryPath, {
    onNone: () => Console.log(summary),
    onSome: (path) => fs.writeFileString(path, summary, { flag: "a" }),
  });

  yield* Option.match(outputPath, {
    onNone: () => Console.log(outputs),
    onSome: (path) => fs.writeFileString(path, outputs, { flag: "a" }),
  });
});

/**
 * Classify decoded plan rows, check them against `--fingerprint` and report. A fingerprint
 * mismatch stops before anything is written.
 *
 * @param rows - The decoded plan rows.
 * @param expected - The digest from `--fingerprint`, when given.
 * @returns The verdict that was reported.
 */
export const decide = Effect.fn("planProd.decide")(function* decide(
  rows: ReadonlyArray<PlanRow>,
  expected: Option.Option<string>,
) {
  const verdict = yield* checkFingerprint(yield* verdictOf(rows), expected);

  yield* report(verdict);

  return verdict;
});

/**
 * Plan a deploy of `prod` from `alchemy.run.ts` in the working directory. The run must have
 * `CI=true` (the stack refuses `prod` otherwise) and never upgrades the state store, so a missing
 * or outdated store fails the plan.
 */
const planProd = Effect.gen(function* planProd() {
  const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));

  if (!ci) {
    return yield* new PlanProdError({ message: "plan-prod plans prod only with CI=true." });
  }

  const stack = yield* Alchemist.importStack(Alchemist.DEFAULT_ENTRYPOINT);

  const plan = yield* Alchemist.plan({
    operation: "deploy",
    stack,
    stage: "prod",
    updateStateStore: false,
  });

  return yield* rowsOfPlan(plan.resources);
}).pipe(Effect.scoped, Effect.provide(Alchemist.layer()));

/**
 * The program: read the arguments, plan `prod`, decide and report.
 */
const program = Effect.gen(function* program() {
  const expected = yield* parseArgs(yield* (yield* Stdio.Stdio).args);

  yield* decide(yield* planProd, expected);
});

if (import.meta.main) {
  BunRuntime.runMain(
    program.pipe(
      Effect.tapError((failure) => Console.error(failure.message)),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
