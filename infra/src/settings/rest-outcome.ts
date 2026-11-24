import { Console, Effect, Schema } from "effect";
import { HttpClientResponse } from "effect/http";

/**
 * The counts of one run, in the shape `reportLine` prints (`applied`, `unavailable`).
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
 * The outcome of one call: the {@link RestSummary} counter it adds to, or `gone` for a delete of
 * something already gone, which adds to no counter and does not fail the run.
 */
type Kind = keyof RestSummary | "gone";

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
export interface Outcome {
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
export const settle = Effect.fn("settle")(function* settle(
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
    Effect.orElseSucceed((): Outcome => ({ kind: "failed", status: 0 })),
    Effect.flatMap(({ detail, kind, status }) => report(kind, setting, status, detail)),
  );

/**
 * Total the outcomes of a run. A `gone` outcome is in no count and does not fail the run. Any
 * failure ends the run in a {@link RestSettingsError} that carries the same counts.
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
