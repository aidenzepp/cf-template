import * as Cloudflare from "@alchemy.run/cloudflare";
import { RemovalPolicy } from "alchemy";
import { Context, Effect, Option } from "effect";

/**
 * The alert the guard declares: the SQL API query it runs and the request count per `1 h` window
 * above which it fires. `infra` builds both from measured inputs, so neither is a placeholder.
 */
export interface GuardAlertSpec {
  readonly query: string;
  readonly threshold: number;
}

/**
 * What the block needs to declare its resources and to find them again at runtime: the stack and
 * stage that name them, and the alert, which is absent while a measured input is unset.
 */
export class GuardPlan extends Context.Service<
  GuardPlan,
  {
    readonly alert: Option.Option<GuardAlertSpec>;
    readonly identity: { readonly stack: string; readonly stage: string };
  }
>()("@workspace/budget-guard/GuardPlan") {}

/**
 * The plan of the block.
 */
export type GuardPlanValue = typeof GuardPlan.Service;

/**
 * Declare the latch namespace `<stack>-<stage>-guard`, retained on `prod` only.
 *
 * @param plan - The block's plan.
 * @returns The namespace resource.
 */
export const guardNamespace = (plan: GuardPlanValue) =>
  Cloudflare.KV.Namespace("GuardKv", {
    title: `${plan.identity.stack}-${plan.identity.stage}-guard`,
  }).pipe(RemovalPolicy.retain(plan.identity.stage === "prod"));

/**
 * Declare the guard alert: the plan's query counted per `1 h` window, notifying above the plan's
 * threshold. Its destination is the receiver `BudgetGuardLive` registers, so it has no
 * `mechanisms` of its own.
 *
 * @param plan - The block's plan.
 * @returns The alert resource, or none while the plan has no alert; nothing is declared then.
 */
export const guardAlert = (plan: GuardPlanValue) =>
  Option.match(plan.alert, {
    onNone: () => Effect.succeed(Option.none<Cloudflare.Alerting.CustomAlert>()),
    onSome: (spec) =>
      Cloudflare.Alerting.CustomAlert("GuardAlert", {
        every: "1h",
        name: `${plan.identity.stack}-guard-${plan.identity.stage}`,
        query: spec.query,
        trigger: { operator: ">", type: "threshold", value: spec.threshold, window: "1h" },
      }).pipe(Effect.map(Option.some)),
  });

/**
 * Declare the block's resources: the latch namespace, and the alert when the plan has one.
 *
 * @param plan - The block's plan.
 * @returns Nothing.
 */
export const resources = Effect.fn("budgetGuardResources")(function* resources(
  plan: GuardPlanValue,
) {
  yield* guardNamespace(plan);
  yield* guardAlert(plan);
});
