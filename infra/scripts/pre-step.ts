import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as cfD1 from "@distilled.cloud/cloudflare/d1";
import * as cfWorkers from "@distilled.cloud/cloudflare/workers";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { Config, Console, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CloudflarePlanKnob } from "@workspace/config/plan";
import { Workers } from "../stages.ts";

/**
 * The failure of the preview pre-step, with the message the workflow log shows.
 */
export class PreStepError extends Schema.TaggedError<PreStepError>()("PreStepError", {
  message: Schema.String,
}) {}

/**
 * The four states `alchemy state list` is read in. The recorded outputs are inferred until the
 * S-43 oracle replaces `fixtures/state-list/`.
 */
export type StateListing =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Outdated" }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Populated"; readonly stages: ReadonlyArray<string> };

/**
 * A stage a preview deploy owns: `staging-<N>`.
 */
const PREVIEW_STAGE = /^staging-[0-9]+$/u;

/**
 * Any stage name, as one token of a populated listing.
 */
const STAGE_TOKEN = /^(?:prod|staging-[0-9]+|test-[a-z0-9-]+)$/u;

/**
 * Classify the exit code and combined output of `alchemy state list`.
 *
 * @param code - The process exit code.
 * @param output - Stdout and stderr, combined.
 * @returns The listing state; a nonzero exit mentioning an upgrade is Outdated, any other nonzero
 *   exit is Missing.
 */
export const parseStateList = (code: number, output: string): StateListing => {
  if (code !== 0) {
    return /outdated|upgrade/iu.test(output) ? { _tag: "Outdated" } : { _tag: "Missing" };
  }

  const stages = output
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^[-*]\s+/u, ""))
    .filter((line) => STAGE_TOKEN.test(line));

  return stages.length === 0 ? { _tag: "Empty" } : { _tag: "Populated", stages };
};

/**
 * The Workers and D1 databases a plan includes: Workers 500 and D1 100,000 on `paid`.
 */
const INCLUDED = {
  free: { d1: 10, workers: 100 },
  paid: { d1: 100_000, workers: 500 },
} as const;

/**
 * The D1 databases each stage creates.
 */
const PER_STAGE_D1 = 2;

/**
 * Inputs of the preview cap.
 */
export interface CapInput {
  readonly plan: "free" | "paid";
  readonly limit: number;
  readonly liveOtherWorkers: number;
  readonly liveOtherD1: number;
  readonly capWorkers?: number | undefined;
  readonly capD1?: number | undefined;
}

/**
 * Compute `min(PREVIEW_STAGE_LIMIT, capacity)` over Workers and D1, reserves 0, where a `CAP_<r>`
 * override replaces that resource's capacity.
 *
 * @param input - The plan, the limit and the live counts of the account's other resources.
 * @returns The most `staging-<N>` stages the account holds.
 */
export const previewCap = (input: CapInput): number => {
  const included = INCLUDED[input.plan];

  const workers =
    input.capWorkers ?? Math.floor((included.workers - input.liveOtherWorkers) / Workers.length);

  const d1 = input.capD1 ?? Math.floor((included.d1 - input.liveOtherD1) / PER_STAGE_D1);

  return Math.max(0, Math.min(input.limit, workers, d1));
};

/**
 * Pick the stages the sweep destroys: `staging-<N>` whose pull request is closed or merged. A
 * stage whose state is unknown (a `gh` error) is skipped, and `test-<slug>` is never matched.
 *
 * @param stages - Stage names from the listing.
 * @param prState - The pull request state by stage, or `none` when `gh` failed.
 * @returns The stages to destroy and the leftover set, by name.
 */
export const planSweep = (
  stages: ReadonlyArray<string>,
  prState: (stage: string) => Option.Option<string>,
) => {
  const previews = stages.filter((stage) => PREVIEW_STAGE.test(stage));

  const destroy = previews.filter((stage) =>
    Option.match(prState(stage), {
      onNone: () => false,
      onSome: (state) => state === "CLOSED" || state === "MERGED",
    }),
  );

  return { destroy, leftover: stages.filter((stage) => !destroy.includes(stage)) };
};

/**
 * Wrap a failed Cloudflare read as a {@link PreStepError}.
 */
const countsFailed = (cause: unknown) =>
  new PreStepError({
    message: `Cannot read the account's Workers and D1 counts: ${cause instanceof Error ? cause.message : "Cloudflare request failed"}. The credentials need Workers Scripts and D1 read.`,
  });

/**
 * The live counts of the account's Workers and D1 databases that do not belong to this project.
 * Tests provide a fake; {@link AccountCountsLive} reads the account.
 */
export class AccountCounts extends Context.Service<
  AccountCounts,
  {
    /**
     * Count the account's Workers and D1 databases whose names do not start with `<stack>-`.
     */
    readonly read: (
      stack: string,
    ) => Effect.Effect<{ readonly workers: number; readonly d1: number }, PreStepError>;
  }
>()("infra/AccountCounts") {}

/**
 * Read the counts through the Cloudflare route the rate-limit guard uses: `CloudflareApiLive`
 * resolves the credentials and the account, and this reads no profile, token or id source.
 */
export const AccountCountsLive = Layer.effect(
  AccountCounts,
  Effect.gen(function* buildAccountCounts() {
    const context = yield* Layer.build(
      Layer.provide(
        CloudflareApiLive(),
        Layer.mergeAll(BunServices.layer, AuthProvidersLive, FetchHttpClient.layer),
      ),
    );

    return AccountCounts.of({
      read: (stack) =>
        Cloudflare.CloudflareEnvironment.current.pipe(
          Effect.flatMap(({ accountId }) =>
            Effect.all({
              d1: cfD1.listDatabases.items({ accountId }).pipe(
                Stream.filter((db) => !(db.name ?? "").startsWith(`${stack}-`)),
                Stream.runCount,
              ),
              workers: cfWorkers.listScripts.items({ accountId }).pipe(
                Stream.filter((script) => !(script.id ?? "").startsWith(`${stack}-`)),
                Stream.runCount,
              ),
            }),
          ),
          Effect.provideContext(context),
          Effect.mapError(countsFailed),
        ),
    });
  }),
);

/**
 * Enforce the preview cap: fail when `count` staging stages already exist at or past
 * `min(PREVIEW_STAGE_LIMIT, capacity)` and this PR's stage is not one of them.
 *
 * `PREVIEW_STAGE_LIMIT`, `CLOUDFLARE_PLAN`, `CAP_WORKERS` and `CAP_D1` are read through `Config`.
 *
 * @param stack - The project stack name.
 * @param count - The `staging-<N>` stages other than this PR's.
 * @param hasOwn - Whether this PR's stage already exists.
 * @returns Success, or {@link PreStepError} with the cap message.
 */
export const enforceCap = Effect.fn("enforceCap")(function* enforceCap(
  stack: string,
  count: number,
  hasOwn: boolean,
) {
  const limit = yield* Config.Int("PREVIEW_STAGE_LIMIT").pipe(Config.withDefault(10));
  const plan = yield* CloudflarePlanKnob.config;
  const capWorkers = yield* Config.Int("CAP_WORKERS").pipe(Config.option);
  const capD1 = yield* Config.Int("CAP_D1").pipe(Config.option);
  const live = yield* (yield* AccountCounts).read(stack);

  const cap = previewCap({
    capD1: Option.getOrUndefined(capD1),
    capWorkers: Option.getOrUndefined(capWorkers),
    limit,
    liveOtherD1: live.d1,
    liveOtherWorkers: live.workers,
    plan,
  });

  return count >= cap && !hasOwn
    ? yield* new PreStepError({
        message: `Preview limit reached: ${count} staging stages exist and the cap is ${cap}. Close a pull request or raise PREVIEW_STAGE_LIMIT.`,
      })
    : cap;
});

/**
 * Run a command, returning its exit code and combined output.
 */
const run = Effect.fn("run")(function* run(program: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(ChildProcess.make(program, [...args]));
      const output = yield* Stream.mkString(Stream.decodeText(handle.all));
      const code = yield* handle.exitCode;

      return { code: Number(code), output };
    }),
  );
});

/**
 * Read the pull request state of a stage's number, or none on a `gh` error.
 */
const readPrState = (stage: string) =>
  run("gh", ["pr", "view", stage.replace("staging-", ""), "--json", "state", "-q", ".state"]).pipe(
    Effect.map(({ code, output }) => (code === 0 ? Option.some(output.trim()) : Option.none())),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/**
 * Run the pre-step for the current event: on `closed`, list, destroy this PR's stage and sweep;
 * on a deploy, list, sweep and enforce the cap.
 */
const program = Effect.gen(function* preStep() {
  const stack = yield* Config.String("STACK_NAME");
  const pr = yield* Config.String("PR_NUMBER");
  const closed = (yield* Config.String("PR_ACTION").pipe(Config.withDefault(""))) === "closed";
  const own = `staging-${pr}`;

  const listing = yield* run("alchemy", ["state", "list"]).pipe(
    Effect.map(({ code, output }) => parseStateList(code, output)),
  );

  if (listing._tag === "Missing") {
    return yield* new PreStepError({
      message: `The state store ${stack}-state is not bootstrapped, or STACK_NAME was changed.`,
    });
  }

  if (listing._tag === "Outdated") {
    return yield* new PreStepError({
      message: `The state store ${stack}-state is outdated. Upgrade it with the alchemy deploy action.`,
    });
  }

  const stages = listing._tag === "Populated" ? listing.stages : [];

  if (closed) {
    yield* run("alchemy", ["destroy", "--stage", own]);
  }

  const states = new Map<string, Option.Option<string>>();

  for (const stage of stages.filter((name) => PREVIEW_STAGE.test(name) && name !== own)) {
    states.set(stage, yield* readPrState(stage));
  }

  const sweep = planSweep(stages, (stage) => states.get(stage) ?? Option.none());

  for (const stage of sweep.destroy) {
    yield* run("alchemy", ["destroy", "--stage", stage]);
  }

  const leftover = sweep.leftover.filter((stage) => stage !== own || !closed);
  yield* Console.log(`Leftover stages: ${leftover.join(", ") || "none"}`);

  if (closed) {
    return leftover;
  }

  const count = leftover.filter((stage) => PREVIEW_STAGE.test(stage) && stage !== own).length;
  yield* enforceCap(stack, count, leftover.includes(own));

  return leftover;
});

if (import.meta.main) {
  BunRuntime.runMain(
    program.pipe(
      Effect.tapError((failure) => Console.error(failure.message)),
      Effect.provide(Layer.mergeAll(BunServices.layer, AccountCountsLive)),
    ),
    { disableErrorReporting: true },
  );
}
