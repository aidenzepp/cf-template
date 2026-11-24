import { Console, Effect, Schema } from "effect";
import { HttpClientResponse } from "effect/http";
import type { Send } from "./github-client.ts";
import type { Call } from "./rest-calls.ts";

/**
 * The counts of one run, in the shape `reportLine` prints (`applied`, `unavailable`). A call that
 * changed nothing (`unchanged`) or deleted something already gone (`gone`) is in neither.
 */
interface RestSummary {
  readonly applied: number;
  readonly unavailable: number;
  readonly failed: number;
}

/**
 * The failure at the end of a run in which at least one call failed. Every other call still ran.
 */
export class RestSettingsError extends Schema.TaggedError<
  RestSettingsError,
  { readonly brand: unique symbol }
>()("RestSettingsError", {
  applied: Schema.Finite,
  failed: Schema.Finite,
  message: Schema.String,
  unavailable: Schema.Finite,
}) {}

/**
 * The outcome of one call: the {@link RestSummary} counter it adds to, `gone` for a delete of
 * something already gone, or `unchanged` for a setting that already held its declared value and was
 * not written. `gone` and `unchanged` add to no counter and do not fail the run.
 */
type Kind = keyof RestSummary | "gone" | "unchanged";

/**
 * What GitHub says when a feature is not offered to the plan or repository. A 403 or 422 from a
 * tier-gated call counts as `unavailable` only when its response `message` contains one of these
 * (case-insensitive); any other 403 or 422 is `failed`. These are GitHub's observed wordings, not a
 * contract: "... is not available for this repository" (secret scanning, vulnerability alerts),
 * "Advanced Security must be enabled for this repository ..." (code scanning) and "Upgrade to
 * GitHub Pro or make this repository public ..." (rulesets, protection). Errors are documented in
 * https://docs.github.com/en/rest/repos/repos#update-a-repository; the wording is not.
 */
const PLAN_UNAVAILABLE = ["not available", "must be enabled", "upgrade to github"] as const;

/**
 * One call's outcome: its kind, the HTTP status (0 for a transport failure), and, for a rejected
 * request, GitHub's `message`.
 */
interface Outcome {
  readonly kind: Kind;
  readonly status: number;
  readonly detail?: string;
}

/**
 * How {@link settle} reads a response: `gated` marks a tier-gated call, `allowGone` reads 404 as
 * `gone`, `phrases` adds message phrases that mean unavailable for this call alone.
 */
interface SettleOptions {
  readonly gated?: boolean;
  readonly allowGone?: boolean;
  readonly phrases?: ReadonlyArray<string>;
}

/**
 * Sort a response into an {@link Outcome}. 2xx applies; a 404 where `allowGone` is set is `gone`:
 * the thing was already deleted, so nothing was written and nothing failed; a 403 or 422 on a
 * `gated` call whose message says the feature is not offered ({@link PLAN_UNAVAILABLE}) is
 * `unavailable`. Everything else is `failed` and carries the response `message` (one line, 200
 * characters at most; never headers or the token).
 *
 * @param response - The GitHub response.
 * @param options - `gated` marks a tier-gated call; `allowGone` reads 404 as `gone`;
 *   `phrases` adds message phrases that count as unavailable for this call alone.
 * @returns The outcome.
 */
const settle = Effect.fn("settle")(function* settle(
  response: HttpClientResponse.HttpClientResponse,
  options: SettleOptions = {},
) {
  const { status } = response;

  if (status >= 200 && status < 300) {
    return { kind: "applied", status } satisfies Outcome;
  }

  if (options.allowGone === true && status === 404) {
    return { kind: "gone", status } satisfies Outcome;
  }

  const { message = "" } = yield* HttpClientResponse.schemaBodyJson(
    Schema.Struct({ message: Schema.optional(Schema.String) }),
  )(response).pipe(Effect.orElseSucceed(() => ({ message: undefined })));

  const lower = message.toLowerCase();

  return (
    options.gated === true &&
    (status === 403 || status === 422) &&
    [...PLAN_UNAVAILABLE, ...(options.phrases ?? [])].some((phrase) => lower.includes(phrase))
      ? { kind: "unavailable", status }
      : { detail: message.replaceAll(/\s+/gu, " ").slice(0, 200), kind: "failed", status }
  ) satisfies Outcome;
});

/**
 * Print one outcome line and return its kind.
 *
 * @param kind - The outcome.
 * @param setting - The setting's name.
 * @param status - The HTTP status, 0 for a transport failure, or `tier` when the call was skipped.
 * @param detail - GitHub's message for a failed call, appended to the line when not empty.
 * @returns The kind, after the line is printed.
 */
export const report = (kind: Kind, setting: string, status: number | "tier", detail = "") =>
  Console.log(
    `${kind} ${setting} ${status === 0 ? "error" : status}${detail === "" ? "" : ` ${detail}`}`,
  ).pipe(Effect.as(kind));

/**
 * The outcome of a request that got no response: a transport failure.
 */
const FAILED: Outcome = { kind: "failed", status: 0 };

/**
 * Print the line of a setting that already held its declared value and was not written.
 *
 * @param setting - The setting's name.
 * @returns The `unchanged` kind, after the line is printed.
 */
export const reportUnchanged = (setting: string) =>
  Console.log(`unchanged ${setting}`).pipe(Effect.as<Kind>("unchanged"));

/**
 * Settle one response, print its outcome line, and return the kind. A transport failure is
 * `failed`.
 *
 * @param setting - The setting's name.
 * @param sent - The request, already built.
 * @param options - As for {@link settle}.
 * @returns The kind, after the line is printed.
 */
export const reportResponse = <E, R>(
  setting: string,
  sent: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
  options?: SettleOptions,
) =>
  sent.pipe(
    Effect.flatMap((response) => settle(response, options)),
    Effect.orElseSucceed(() => FAILED),
    Effect.flatMap(({ detail, kind, status }) => report(kind, setting, status, detail)),
  );

/**
 * Total the outcomes of a run. A `gone` or `unchanged` outcome is in no count and does not fail the
 * run. Any failure ends the run in a {@link RestSettingsError} that carries the same counts.
 *
 * @param kinds - One outcome per call.
 * @returns The counts, or a {@link RestSettingsError} when any call failed.
 */
export const summarize = (kinds: ReadonlyArray<Kind>) => {
  const count = (kind: Kind) => kinds.filter((value) => value === kind).length;

  const summary = {
    applied: count("applied"),
    failed: count("failed"),
    unavailable: count("unavailable"),
  };

  return summary.failed === 0
    ? Effect.succeed(summary satisfies RestSummary)
    : Effect.fail(
        new RestSettingsError({
          ...summary,
          message: `${summary.failed} settings call(s) failed; ${summary.applied} applied, ${summary.unavailable} unavailable.`,
        }),
      );
};

/**
 * Send a call, and when it applied, read the repository back: the call stays `applied` only if
 * `security_and_analysis[confirm].status` is `enabled`, otherwise it is `unavailable` ("silently
 * ignored by GitHub"). A failed read-back is `failed`.
 *
 * @param send - The REST sender.
 * @param call - The call; its `confirm` key is read back.
 * @param confirm - The `security_and_analysis` key to verify.
 * @returns The kind, after the outcome line is printed.
 */
export const applyConfirmed = (send: Send, call: Call, confirm: string) =>
  send(call.method, call.path, call.body).pipe(
    Effect.flatMap((response) => settle(response, { gated: true, phrases: call.phrases })),
    Effect.filterOrElse(
      (outcome) => outcome.kind !== "applied",
      (outcome) =>
        send("GET", call.path).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Struct({
                security_and_analysis: Schema.optional(
                  Schema.Record(
                    Schema.String,
                    Schema.Struct({ status: Schema.optional(Schema.String) }),
                  ),
                ),
              }),
            ),
          ),
          Effect.map((repository) =>
            repository.security_and_analysis?.[confirm]?.status === "enabled"
              ? outcome
              : ({
                  detail: "silently ignored by GitHub",
                  kind: "unavailable",
                  status: outcome.status,
                } satisfies Outcome),
          ),
        ),
    ),
    Effect.orElseSucceed(() => FAILED),
    Effect.flatMap(({ detail, kind, status }) => report(kind, call.setting, status, detail)),
  );
