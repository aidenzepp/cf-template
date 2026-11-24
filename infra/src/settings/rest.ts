import { Effect } from "effect";
import {
  applyConfirmed,
  report,
  reportResponse,
  reportUnchanged,
  summarize,
} from "./call-outcome.ts";
import { alreadyHolds, restClient } from "./github-client.ts";
import type { Send } from "./github-client.ts";
import type { GuardedRepository } from "./repository.ts";
import { callsFor } from "./rest-calls.ts";
import type { Call } from "./rest-calls.ts";
import type { Tier } from "./tier.ts";

/**
 * Read the setting, and print `unchanged` without writing when it already holds the declared
 * value. Otherwise send the call and print its outcome line, reading the repository back when the
 * call names a `confirm` key.
 *
 * @param send - The REST sender.
 * @param call - The call.
 * @returns The kind, after the outcome line is printed.
 */
const sendCall = (send: Send, call: Call) =>
  alreadyHolds(send, call.path, call.expected ?? call.body).pipe(
    Effect.flatMap((unchanged) => {
      if (unchanged) {
        return reportUnchanged(call.setting);
      }

      return call.confirm === undefined
        ? reportResponse(call.setting, send(call.method, call.path, call.body), {
            gated: call.need !== undefined,
            phrases: call.phrases,
          })
        : applyConfirmed(send, call, call.confirm);
    }),
  );

/**
 * Run every repository settings call the tier allows, print one outcome line each, and total them.
 * A setting that already holds its declared value is read first, not written, and prints
 * `unchanged <setting>`; it is not in the `applied` count.
 *
 * A failed call never stops the rest. A transport failure counts as `failed`. When any call failed
 * the run ends in a `RestSettingsError` (see `call-outcome.ts`) carrying the counts.
 *
 * @param repository - The guarded repository.
 * @param tier - The detected tier whose capabilities gate each call.
 * @returns The counts, or a `RestSettingsError` when any call failed.
 */
export const applyRest = Effect.fn("applyRest")(function* applyRest(
  repository: GuardedRepository,
  tier: Pick<Tier, "capabilities">,
) {
  const send = yield* restClient;

  const kinds = yield* Effect.forEach(callsFor(`${repository.owner}/${repository.name}`), (call) =>
    call.need !== undefined && !tier.capabilities.has(call.need)
      ? report("unavailable", call.setting, "tier")
      : sendCall(send, call),
  );

  return yield* summarize(kinds);
});
