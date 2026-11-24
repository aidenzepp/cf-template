import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as cfD1 from "@distilled.cloud/cloudflare/d1";
import * as cfWorkers from "@distilled.cloud/cloudflare/workers";
import { BunServices } from "@effect/platform-bun";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { Config, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { CloudflarePlanKnob } from "@workspace/config/plan";
import { Workers } from "../worker-names.ts";

/**
 * The failure of the preview pre-step, with the message the workflow log shows.
 */
export class PreStepError extends Schema.TaggedError<
  PreStepError,
  { readonly brand: unique symbol }
>()("PreStepError", {
  message: Schema.String,
}) {}

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
interface CapInput {
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
