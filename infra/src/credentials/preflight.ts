import { Effect, Option } from "effect";
import { CredentialsError } from "./error.ts";
import { PREREQUISITES, PROBES, STEP_1 } from "./runbook.ts";
import { requirePaid } from "./plan.ts";
import { SpinUp } from "./spin-up.ts";

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
