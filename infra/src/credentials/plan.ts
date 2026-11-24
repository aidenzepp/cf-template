import { CloudflarePlanKnob } from "@workspace/config/plan";
import { Effect, Option } from "effect";
import { CredentialsError, PLAN_PAGE, PREREQUISITES } from "./model.ts";
import type { Plan } from "./model.ts";
import { SpinUp } from "./spin-up.ts";

/**
 * The Workers plan: the detector's answer when it returns one, else `CLOUDFLARE_PLAN`. The knob is
 * read only when the detector fails.
 *
 * @param profile - The profile the detector mints its token under.
 * @returns The plan.
 */
export const workersPlan = Effect.fn("workersPlan")(function* workersPlan(profile: string) {
  const spinUp = yield* SpinUp;

  return yield* spinUp.detectPlan(profile).pipe(
    Effect.catch(() =>
      CloudflarePlanKnob.config.pipe(
        Effect.mapError(
          () =>
            new CredentialsError({
              message: `CLOUDFLARE_PLAN must be free or paid. ${PREREQUISITES}`,
            }),
        ),
      ),
    ),
  );
});

/**
 * Refuse a Free account: the password hash costs about `115 ms` of CPU against the Free plan's
 * `10 ms` limit.
 *
 * @param profile - The profile the detector runs under.
 * @returns Nothing on Paid, or the refusal on Free.
 */
export const requirePaid = Effect.fn("requirePaid")(function* requirePaid(profile: string) {
  const plan = yield* workersPlan(profile);

  return plan === "paid"
    ? undefined
    : yield* new CredentialsError({
        message: `The account is on Workers Free. Compare on ${PLAN_PAGE}: the Free plan allows 10 ms of CPU per request and one password hash costs about 115 ms. Upgrade to Workers Paid and run again. ${PREREQUISITES}`,
      });
});

/**
 * Read the Workers plan from the account's subscriptions (**unverified**: whether the Paid plan
 * appears there and under which rate plan). A subscription whose rate plan names Workers decides;
 * none deciding is no answer.
 *
 * @param items - The subscriptions.
 * @returns The plan, or none.
 */
export const planOf = (
  items: ReadonlyArray<{
    readonly price?: number | null;
    readonly ratePlan?: { readonly id?: string | null; readonly publicName?: string | null } | null;
  }>,
): Option.Option<Plan> => {
  const workers = items.find((item) =>
    `${item.ratePlan?.id ?? ""} ${item.ratePlan?.publicName ?? ""}`
      .toLowerCase()
      .includes("workers"),
  );

  if (workers === undefined) {
    return Option.none();
  }

  const name = `${workers.ratePlan?.id ?? ""} ${workers.ratePlan?.publicName ?? ""}`.toLowerCase();

  return Option.some(name.includes("free") || (workers.price ?? 0) === 0 ? "free" : "paid");
};
