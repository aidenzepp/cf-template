import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Option } from "effect";
import type { GuardPlanValue } from "@workspace/budget-guard/stack";
import { workerName } from "../stages.ts";
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
