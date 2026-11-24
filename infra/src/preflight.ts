import { CloudflarePlanKnob } from "@workspace/config/plan";
import { Effect, Option } from "effect";
import { CredentialsError, STEP_1, SpinUp } from "./spin-up.ts";
import type { Plan, ReadProbe } from "./credentials-types.ts";

/**
 * The runbook reference of the Bun pin and Workers Paid refusals.
 */
const PREREQUISITES = "See docs/spin-up.md, Prerequisites.";

/**
 * The dashboard page that shows the account's Workers plan.
 */
export const PLAN_PAGE = "https://dash.cloudflare.com/?to=/:account/workers/plans";

/**
 * What each probe lists, the permission group the token lacks when it is denied, and the Edit
 * group the step needs. Edit cannot be probed without writing, so the message names it.
 */
export const PROBES: Record<ReadProbe, { readonly lists: string; readonly missing: string }> = {
  d1: {
    lists: "D1 databases",
    missing: "D1 Read (the collision check lists databases)",
  },
  "secrets-store": {
    lists: "Secrets Store stores",
    missing: "Secrets Store Edit (the state store's default store and auth-token secret)",
  },
  workers: {
    lists: "Workers scripts",
    missing:
      "Workers Scripts Edit (the collision check, the workers.dev subdomain, and the state store's Worker upload, Durable Object namespace and subdomain)",
  },
};

/**
 * Probe the admin token's reads in order and refuse on the first one Cloudflare denies, before
 * any write.
 *
 * @param profile - The admin profile.
 * @returns Nothing when all three reads answer.
 */
export const permissionPreflight = Effect.fn("permissionPreflight")(function* permissionPreflight(
  profile: string,
) {
  const spinUp = yield* SpinUp;

  yield* Effect.forEach(
    ["workers", "d1", "secrets-store"] as const,
    (group) =>
      spinUp.canRead(profile, group).pipe(
        Effect.filterOrFail(
          (readable) => readable,
          () =>
            new CredentialsError({
              message: `The admin token cannot list ${PROBES[group].lists}, so it lacks a permission group. Add ${PROBES[group].missing} to the token's account permissions, update it with \`bun run alchemy profile edit --profile admin\`, and run again. ${STEP_1}`,
            }),
        ),
      ),
    { discard: true },
  );
});

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
const requirePaid = Effect.fn("requirePaid")(function* requirePaid(profile: string) {
  const plan = yield* workersPlan(profile);

  return plan === "paid"
    ? undefined
    : yield* new CredentialsError({
        message: `The account is on Workers Free. Compare on ${PLAN_PAGE}: the Free plan allows 10 ms of CPU per request and one password hash costs about 115 ms. Upgrade to Workers Paid and run again. ${PREREQUISITES}`,
      });
});

/**
 * Refuse unless the running Bun is the `packageManager` pin, the token is an admin of the
 * repository, the `default` and the selected profile exist, and the account is on Workers Paid.
 *
 * @param slug - The repository `owner/name`.
 * @param profile - The profile the bootstrap runs under.
 * @returns The repository view, or the {@link CredentialsError} of the first refusal.
 */
export const preflight = Effect.fn("preflight")(function* preflight(slug: string, profile: string) {
  const spinUp = yield* SpinUp;
  const running = yield* spinUp.bunVersion;
  const pinned = yield* spinUp.bunPin;

  if (running !== pinned) {
    return yield* new CredentialsError({
      message: `Bun ${running} is running but package.json pins bun@${pinned}. Install Bun ${pinned} and run again. ${PREREQUISITES}`,
    });
  }

  const view = yield* spinUp.repository(slug);

  if (Option.isNone(view) || !view.value.admin) {
    return yield* new CredentialsError({
      message: `GET /repos/${slug} did not answer 200 with permissions.admin: true. Sign gh in as the repository owner (\`gh auth login\`) and run again. ${STEP_1}`,
    });
  }

  const profiles = yield* spinUp.profiles;
  const missing = ["default", profile].filter((name) => !profiles.includes(name));

  if (missing.length > 0) {
    return yield* new CredentialsError({
      message: `The Alchemy profile ${missing.map((name) => `\`${name}\``).join(" and ")} is missing. Create it with \`bun run alchemy profile create\` and \`bun run alchemy profile edit\`, then run again. ${STEP_1}`,
    });
  }

  yield* requirePaid(profile);

  return view.value;
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
