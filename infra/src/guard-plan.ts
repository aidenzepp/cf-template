import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Option } from "effect";
import { guardNamespace, resources } from "@workspace/budget-guard/stack";
import type { GuardPlanValue } from "@workspace/budget-guard/stack";
import { kindOf, workerName } from "../stages.ts";
import type { StageName } from "../stages.ts";
import { volumeAlertQuery, volumeAlertWorkers } from "./alerts.ts";
import { compat } from "./compat.ts";
import { guardThreshold } from "./guard-threshold.ts";

/**
 * Build the plan of the budget guard block for a stage: its identity, the receiver Worker's name
 * and compatibility, and the alert, which exists only while {@link guardThreshold} derives a
 * threshold. The alert counts the same Worker invocations as the volume alert.
 *
 * @param identity - The stack name and decoded stage.
 * @param identity.stack - The stack name from `resolveStackName`.
 * @param identity.stage - The decoded stage.
 * @returns The plan, or the failure of an invalid knob or an over-long Worker name.
 */
export const guardPlan = Effect.fn("guardPlan")(function* guardPlan(identity: {
  readonly stack: string;
  readonly stage: StageName;
}) {
  const threshold = yield* guardThreshold;
  const { accountId } = yield* Cloudflare.CloudflareEnvironment.current;
  const workers = yield* volumeAlertWorkers(identity.stack, identity.stage);

  return {
    alert: threshold.pipe(
      Option.map((value) => ({ query: volumeAlertQuery(accountId, workers), threshold: value })),
    ),
    identity,
    receiver: {
      compatibility: { date: compat.date, flags: compat.flags.map((flag) => flag.name) },
      name: yield* workerName({ ...identity, worker: "guard" }),
    },
  } satisfies GuardPlanValue;
});

/**
 * Whether a stage declares the budget guard's receiver Worker and the alert it consumes, the one
 * place that is decided. The `test` kind (`test-ci`, `test-<slug>`) does not: the account holder
 * ruled that test stages carry no alerts or anything else superfluous, and the approved list
 * (2026-11-14) drops the receiver there. Every stage still declares the latch namespace `GuardKv`,
 * which `web` binds as `GUARD_KV`.
 *
 * @param stage - The decoded stage.
 * @returns `false` for the `test` kind, `true` for `prod`, `staging` and `local`.
 */
export const declaresGuardReceiver = (stage: StageName): boolean => kindOf(stage) !== "test";

/**
 * Declare the budget guard block for a stage: every resource of the block where
 * {@link declaresGuardReceiver} allows the receiver, otherwise the latch namespace alone.
 *
 * @param stage - The decoded stage.
 * @param plan - The block's plan from {@link guardPlan}.
 * @returns Nothing.
 */
export const declareGuard = Effect.fn("declareGuard")(function* declareGuard(
  stage: StageName,
  plan: GuardPlanValue,
) {
  if (declaresGuardReceiver(stage)) {
    yield* resources(plan);

    return;
  }

  yield* guardNamespace(plan);
});
