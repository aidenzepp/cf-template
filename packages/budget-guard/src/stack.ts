import { Effect } from "effect";
import { declareReceiver } from "./receiver.ts";
import { guardAlert, guardNamespace } from "./resources.ts";
import type { GuardPlanValue } from "./resources.ts";

export { guardNamespace } from "./resources.ts";

export type { GuardPlanValue } from "./resources.ts";

/**
 * Declare the block's resources: the latch namespace, the alert when the plan has one, and the
 * receiver Worker that latches the alert's notifications.
 *
 * This is the entry `infra` imports. It is not `./live`, because the receiver Worker's platform
 * code cannot enter the bundle of `web`, which imports `./live`.
 *
 * @param plan - The block's plan.
 * @returns Nothing.
 */
export const resources = Effect.fn("budgetGuardResources")(function* resources(
  plan: GuardPlanValue,
) {
  yield* guardNamespace(plan);
  yield* guardAlert(plan);
  yield* declareReceiver(plan);
});
