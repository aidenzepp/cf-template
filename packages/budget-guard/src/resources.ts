import * as Cloudflare from "@alchemy.run/cloudflare";
import { RemovalPolicy } from "alchemy";
import { Context, Effect, Option } from "effect";

/**
 * The logical id of the latch namespace, the key of its Alchemy state.
 */
export const GUARD_KV_ID = "GuardKv";

/**
 * The logical id of the guard alert; the receiver's delivery path and secret name derive from it.
 */
export const GUARD_ALERT_ID = "GuardAlert";

/**
 * The alert the guard declares: the SQL API query it runs and the request count per `1 h` window
 * above which it fires. `infra` builds both from measured inputs, so neither is a placeholder.
 */
export interface GuardAlertSpec {
  readonly query: string;
  readonly threshold: number;
}

/**
 * What the block needs to declare its resources: the stack and stage that name them, the alert,
 * which is absent while a measured input is unset, and the receiver Worker's name and
 * compatibility.
 */
export class GuardPlan extends Context.Service<
  GuardPlan,
  {
    readonly alert: Option.Option<GuardAlertSpec>;
    readonly identity: { readonly stack: string; readonly stage: string };
    readonly receiver: {
      readonly compatibility: {
        readonly date: string;
        readonly flags: ReadonlyArray<string>;
      };
      readonly name: string;
    };
  }
>()("@workspace/budget-guard/GuardPlan") {}

/**
 * The plan of the block.
 */
export type GuardPlanValue = typeof GuardPlan.Service;

/**
 * The title of the latch namespace of a stage: the lookup key of the reset command.
 *
 * @param stack - The stack name.
 * @param stage - The decoded stage.
 * @returns `<stack>-<stage>-guard`.
 */
export const guardNamespaceTitle = (stack: string, stage: string) => `${stack}-${stage}-guard`;

/**
 * Declare the latch namespace `<stack>-<stage>-guard`, retained on `prod` only.
 *
 * @param plan - The block's plan.
 * @returns The namespace resource.
 */
export const guardNamespace = (plan: GuardPlanValue) =>
  Cloudflare.KV.Namespace(GUARD_KV_ID, {
    title: guardNamespaceTitle(plan.identity.stack, plan.identity.stage),
  }).pipe(RemovalPolicy.retain(plan.identity.stage === "prod"));

/**
 * The name of a stage's guard alert: the alert's `name` and the policy name the receiver Worker is
 * bound, so the two cannot differ.
 *
 * @param plan - The block's plan.
 * @returns `<stack>-guard-<stage>`.
 */
export const guardAlertName = (plan: GuardPlanValue) =>
  `${plan.identity.stack}-guard-${plan.identity.stage}`;

/**
 * The properties of the guard alert: the plan's query counted per `1 h` window, notifying above
 * the plan's threshold. Its destination is the receiver, so it has no `mechanisms` of its own.
 *
 * @param plan - The block's plan.
 * @param spec - The alert the plan declares.
 * @returns The properties of the `CustomAlert`.
 */
export const guardAlertProps = (plan: GuardPlanValue, spec: GuardAlertSpec) =>
  ({
    every: "1h",
    name: guardAlertName(plan),
    query: spec.query,
    trigger: { operator: ">", type: "threshold", value: spec.threshold, window: "1h" },
  }) as const satisfies Cloudflare.Alerting.CustomAlertProps;

/**
 * The alert a receiver Worker registers for a plan's alert, with the policy name it is bound: both
 * come from {@link guardAlertName}, so the bound name is never empty.
 *
 * @param plan - The block's plan.
 * @param spec - The alert the plan declares.
 * @returns The alert properties and the policy name.
 */
export const guardReceiverAlert = (plan: GuardPlanValue, spec: GuardAlertSpec) => ({
  policy: guardAlertName(plan),
  props: guardAlertProps(plan, spec),
});

/**
 * Declare the guard alert.
 *
 * @param plan - The block's plan.
 * @returns The alert resource, or none while the plan has no alert; nothing is declared then.
 */
export const guardAlert = (plan: GuardPlanValue) =>
  Option.match(plan.alert, {
    onNone: () => Effect.succeed(Option.none<Cloudflare.Alerting.CustomAlert>()),
    onSome: (spec) =>
      Cloudflare.Alerting.CustomAlert(GUARD_ALERT_ID, guardAlertProps(plan, spec)).pipe(
        Effect.map(Option.some),
      ),
  });
