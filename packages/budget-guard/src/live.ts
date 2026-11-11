import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Context, DateTime, Effect, Layer, Option, Ref } from "effect";
import { GuardPlan, guardAlert, guardNamespace } from "./resources.ts";

export { resources } from "./resources.ts";

/**
 * The KV key that holds the latch.
 */
const LATCH_KEY = "state";

/**
 * The longest a latch read is reused inside one isolate.
 */
const READ_TTL = "30 seconds";

/**
 * The path prefix of static assets, which are never refused.
 */
const ASSET_PREFIX = "/assets/";

/**
 * The body of the 503 answer, as `application/problem+json`.
 */
const LATCHED_BODY =
  '{"type":"/problems/budget-latched","title":"Service paused","status":503,"detail":"Request volume crossed the project\'s budget line; serving resumes when the latch clears."}';

/**
 * Where the guard reads and writes the latch: whether it is set, and set it until `expiration`.
 */
export interface LatchStore<E, R> {
  readonly isLatched: Effect.Effect<boolean, E, R>;
  readonly latch: (value: {
    readonly at: number;
    readonly correlationId: string | undefined;
    readonly expiration: number;
  }) => Effect.Effect<void, E, R>;
}

/**
 * The guard `web` asks about every request.
 */
export class BudgetGuard extends Context.Service<
  BudgetGuard,
  {
    /**
     * The 503 answer while the latch is set, else `undefined`. Never fails: a failed read serves.
     */
    readonly check: (
      request: Request,
    ) => Effect.Effect<Response | undefined, never, RuntimeContext>;
  }
>()("@workspace/budget-guard/BudgetGuard") {}

/**
 * The first instant of the next UTC month in epoch seconds: where the billing-period end is taken
 * from, as no account billing date is read.
 *
 * @returns The expiration to put on a latch.
 */
export const periodEnd = Effect.gen(function* periodEndSeconds() {
  const now = yield* DateTime.now;

  return Math.ceil(DateTime.toEpochMillis(DateTime.endOf(now, "month")) / 1000);
});

/**
 * Build the guard over a latch store.
 *
 * `check` reads the latch at most once per `30` s per isolate and answers the 503 on every path
 * but static assets while it is set. A failed read serves normally and logs `web.guard.read_error`
 * at Error once per isolate.
 *
 * @param store - The latch store.
 * @returns The `check` of the guard.
 */
export const makeCheck = <E, R>(store: Pick<LatchStore<E, R>, "isLatched">) =>
  Effect.gen(function* makeCheckEffect() {
    const logged = yield* Ref.make(false);

    const read = store.isLatched.pipe(
      Effect.catch(() =>
        Ref.getAndSet(logged, true).pipe(
          Effect.flatMap((already) =>
            already ? Effect.void : Effect.logError("web.guard.read_error"),
          ),
          Effect.as(false),
        ),
      ),
    );

    const latched = yield* Effect.cachedWithTTL(read, READ_TTL);

    return (request: Request): Effect.Effect<Response | undefined, never, R> =>
      new URL(request.url).pathname.startsWith(ASSET_PREFIX)
        ? Effect.succeed(undefined)
        : latched.pipe(
            Effect.map((isLatched) =>
              isLatched
                ? new Response(LATCHED_BODY, {
                    headers: { "content-type": "application/problem+json", "retry-after": "300" },
                    status: 503,
                  })
                : undefined,
            ),
          );
  });

/**
 * The `web` layer of the block: the receiver of the guard alert's notifications and the
 * {@link BudgetGuard} `web` asks about every request.
 *
 * The receiver rejects a delivery without the `cf-webhook-auth` secret before it runs, then
 * latches only a notification whose `policyId` is this stage's guard alert, until the period end.
 * It writes through the KV binding, never an account token. While the plan has no alert there is
 * no receiver, and the latch path still serves.
 */
export const BudgetGuardLive = Layer.effect(
  BudgetGuard,
  Effect.gen(function* budgetGuardLive() {
    const plan = yield* GuardPlan;
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(guardNamespace(plan));
    const alert = yield* guardAlert(plan);

    const store: LatchStore<Cloudflare.KV.NamespaceError, RuntimeContext> = {
      isLatched: kv.get(LATCH_KEY).pipe(Effect.map((value) => value !== null)),
      latch: ({ at, correlationId, expiration }) =>
        kv.put(LATCH_KEY, JSON.stringify({ at, correlationId, latched: true }), { expiration }),
    };

    if (Option.isSome(alert)) {
      const policy = yield* Output.named(alert.value.policyId, "BUDGET_GUARD_POLICY_ID");

      yield* Cloudflare.Alerting.consumeNotifications(alert.value, (notification) =>
        Effect.gen(function* receive() {
          if (notification.policyId !== (yield* policy)) {
            return;
          }

          yield* store.latch({
            at: notification.ts,
            correlationId: notification.alertCorrelationId,
            expiration: yield* periodEnd,
          });
        }).pipe(Effect.catch((error) => Effect.logError("web.guard.latch_error", error))),
      );
    }

    return BudgetGuard.of({ check: yield* makeCheck(store) });
  }),
);
