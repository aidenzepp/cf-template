import { DateTime, Effect, Schema } from "effect";

/**
 * The KV key that holds the latch.
 */
export const LATCH_KEY = "state";

/**
 * The latch record: when the alert fired, its correlation id if it carried one, and the set flag.
 */
const Latch = Schema.Struct({
  at: Schema.Number,
  correlationId: Schema.optional(Schema.String),
  latched: Schema.Literal(true),
});

/**
 * The latch record as the JSON text kept under {@link LATCH_KEY}.
 */
export const LatchJson = Schema.fromJsonString(Latch);

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
 * The parts of a notification the receiver reads.
 */
export interface Delivery {
  readonly alertCorrelationId: string | undefined;
  readonly policyName: string | undefined;
  readonly ts: number;
}

/**
 * Build the handler of the guard alert's notifications over a KV write.
 *
 * The handler latches only a notification whose `policyName` is `policy`, the name of this stage's
 * guard alert; a notification with no `policyName`, or one of another policy, writes nothing and
 * logs `web.guard.policy_mismatch` at Warning with the received and expected names. The
 * name stands in for the policy id: it is known when the alert is declared, so binding it onto the
 * receiver Worker adds no dependency on the alert. The latch holds until {@link periodEnd}. A
 * failed write logs `web.guard.latch_error` and never fails the delivery.
 *
 * @param options - Where the handler reads the policy name and writes the latch.
 * @param options.policy - The name of the guard alert, `undefined` or empty while the Worker has
 *   none bound.
 * @param options.put - Write a key with an `expiration` in epoch seconds.
 * @returns The handler for one notification.
 */
export const makeReceive =
  <E, R>(options: {
    readonly policy: Effect.Effect<string | undefined>;
    readonly put: (
      key: string,
      value: string,
      settings: { readonly expiration: number },
    ) => Effect.Effect<void, E, R>;
  }) =>
  (delivery: Delivery): Effect.Effect<void, never, R> =>
    Effect.gen(function* receive() {
      const policy = yield* options.policy;

      if (policy === undefined || policy === "") {
        return;
      }

      if (delivery.policyName !== policy) {
        yield* Effect.logWarning("web.guard.policy_mismatch").pipe(
          Effect.annotateLogs({ expected: policy, received: delivery.policyName ?? "missing" }),
        );

        return;
      }

      const value = yield* Schema.encodeEffect(LatchJson)({
        at: delivery.ts,
        correlationId: delivery.alertCorrelationId,
        latched: true,
      });

      yield* options.put(LATCH_KEY, value, { expiration: yield* periodEnd });
    }).pipe(Effect.catchCause((cause) => Effect.logError("web.guard.latch_error", cause)));
