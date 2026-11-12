import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Http from "alchemy/Http";
import type { InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Context, Effect, Layer, Option, Path } from "effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { makeReceive } from "./latch.ts";
import { GUARD_ALERT_ID, GUARD_KV_ID, guardAlertProps } from "./resources.ts";
import type { GuardPlanValue } from "./resources.ts";

/**
 * What `infra` supplies to the receiver Worker when it plans: the block's plan and the path of the
 * Worker's own module. The deployed bundle evaluates this module with no provider, so the service
 * is optional there and every property it would carry is ignored: the Worker is already deployed.
 */
export class GuardDeployment extends Context.Service<
  GuardDeployment,
  { readonly main: string; readonly plan: GuardPlanValue }
>()("@workspace/budget-guard/GuardDeployment") {}

/**
 * The deploy properties of the receiver Worker: `infra`'s when it plans, none in the deployed
 * bundle. It has an address because Cloudflare delivers the alert's notifications to it, and it
 * answers `404` on every path but the delivery path.
 */
const receiverProps = Effect.serviceOption(GuardDeployment).pipe(
  Effect.map(
    Option.match({
      onNone: (): InputProps<Cloudflare.WorkerProps> => ({}),
      onSome: ({ main, plan }): InputProps<Cloudflare.WorkerProps> => ({
        compatibility: {
          date: plan.receiver.compatibility.date,
          flags: [...plan.receiver.compatibility.flags],
        },
        main,
        name: plan.receiver.name,
        workersDev: true,
      }),
    }),
  ),
);

/**
 * The alert properties the deployed bundle registers. Nothing reads them there: the bundle needs
 * the alert's logical id to find its delivery path and its secret, and Alchemy never plans from
 * inside a deployed Worker. They never reach a deploy, which uses {@link guardAlertProps}.
 */
const BUNDLE_ALERT = {
  query: "",
  trigger: { operator: ">", type: "threshold", value: 0, window: "1h" },
} as const satisfies Cloudflare.Alerting.CustomAlertProps;

/**
 * The entrypoint of the receiver Worker: it exposes no RPC method, and its `fetch` answers `404`.
 */
export interface ReceiverEntrypoint extends MainRpc<RuntimeContext> {
  readonly fetch: Http.HttpEffect;
}

/**
 * The tag of the receiver Worker, whose only job is to latch the guard alert's notifications into
 * the guard namespace.
 */
export class GuardReceiver extends Cloudflare.Worker<GuardReceiver, ReceiverEntrypoint>()(
  "GuardReceiver",
) {}

/**
 * The receiver Worker: it consumes the guard alert's notifications at the alert's own delivery
 * path, which rejects a request without the `cf-webhook-auth` secret, then latches the ones whose
 * `policyName` is this alert's name. It writes through its KV binding and holds no account token.
 * The Worker is bound the alert's name, a plain string, and not its policy id: the id is an output
 * of the alert, which would make the Worker, the webhook and the alert depend on each other, and
 * Alchemy would test the webhook against the Worker's placeholder before the Worker holds its
 * secret.
 *
 * While the plan has no alert, a planning run registers no alert and no route; the deployed bundle
 * has no plan to read, registers the route, and a delivery then finds no secret bound and is
 * answered `500`, so it latches nothing.
 */
export const GuardReceiverLive = GuardReceiver.make(
  receiverProps,
  Effect.gen(function* buildReceiver() {
    const deployment = yield* Effect.serviceOption(GuardDeployment);

    const props = Option.match(deployment, {
      onNone: () => Option.some<Cloudflare.Alerting.CustomAlertProps>(BUNDLE_ALERT),
      onSome: ({ plan }) =>
        plan.alert.pipe(
          Option.map((spec): Cloudflare.Alerting.CustomAlertProps => guardAlertProps(plan, spec)),
        ),
    });

    if (Option.isSome(props)) {
      const kv = yield* Cloudflare.KV.ReadWriteNamespace(Cloudflare.KV.Namespace(GUARD_KV_ID)).pipe(
        Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding),
      );

      const alert = yield* Cloudflare.Alerting.CustomAlert(GUARD_ALERT_ID, props.value);

      const policy = yield* Output.named(
        Output.asOutput(props.value.name ?? ""),
        "BUDGET_GUARD_POLICY_NAME",
      );

      yield* Cloudflare.Alerting.consumeNotifications(
        alert,
        makeReceive({ policy, put: (key, value, settings) => kv.put(key, value, settings) }),
      );
    }

    return { fetch: Effect.succeed(HttpServerResponse.empty({ status: 404 })) };
  }).pipe(Effect.provide(Cloudflare.Alerting.NotificationEventSourceLive)),
);

export default GuardReceiverLive;

/**
 * Declare the receiver Worker with the module of this file as its entry.
 *
 * @param plan - The block's plan.
 * @returns The Worker resource.
 */
export const declareReceiver = Effect.fn("declareReceiver")(function* declareReceiver(
  plan: GuardPlanValue,
) {
  const path = yield* Path.Path;
  const main = yield* path.fromFileUrl(new URL("receiver.ts", import.meta.url));

  return yield* GuardReceiver.pipe(
    Effect.provide(
      GuardReceiverLive.pipe(Layer.provide(Layer.succeed(GuardDeployment, { main, plan }))),
    ),
  );
});
