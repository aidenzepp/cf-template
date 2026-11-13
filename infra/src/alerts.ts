import * as Cloudflare from "@alchemy.run/cloudflare";
import type { Input } from "alchemy/Input";
import { Config, Effect, Option, Schema } from "effect";
import { AlertFractionKnob, AllowanceShareKnob } from "@workspace/config/observability";
import { Stages, Workers, kindOf, workerName } from "../stages.ts";
import type { StageName, WorkerNameTooLongError } from "../stages.ts";

/**
 * The requests a Workers Paid plan includes per billing period.
 */
const INCLUDED_REQUESTS = 10_000_000;

/**
 * The number of `1 h` windows in a `30 d` billing period.
 */
const HOURLY_WINDOWS = 720;

/**
 * The requests per `1 h` window above which the volume alert fires.
 *
 * @param share - The `ALLOWANCE_SHARE` knob value.
 * @param fraction - The `ALERT_FRACTION` knob value.
 * @returns The included requests times `share` times `fraction`, per `1 h` window, rounded down.
 */
export const volumeAlertThreshold = (share: number, fraction: number): number =>
  Math.floor((INCLUDED_REQUESTS * share * fraction) / HOURLY_WINDOWS);

/**
 * The Worker names the volume alert counts: each entry of `Workers` in order, then the state
 * store `<stack>-state`.
 *
 * It returns an effect because {@link workerName} fails on a name past the Worker name limit.
 *
 * @param stack - The stack name.
 * @param stage - The decoded stage.
 * @returns The Worker names, or the {@link WorkerNameTooLongError} of the first name that is too
 *   long.
 */
export const volumeAlertWorkers = (
  stack: string,
  stage: StageName,
): Effect.Effect<ReadonlyArray<string>, WorkerNameTooLongError> =>
  Effect.all(Workers.map((worker) => workerName({ stack, stage, worker }))).pipe(
    Effect.map((names) => [...names, `${stack}-state`]),
  );

/**
 * An email address as far as the plan can check it: one `@`, a non-empty local part and domain,
 * and no whitespace.
 */
const EmailAddress = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/u));

/**
 * Read the stack input `ISSUE_NOTIFICATION_EMAIL`, only where an alert needs it: a stage whose kind
 * sets `volumeAlert`, or `prod`. Every other stage never reads the variable.
 *
 * @param stage - The decoded stage.
 * @returns The address, or none when the stage declares no alert.
 */
export const issueNotificationAddress = Effect.fn("issueNotificationAddress")(
  function* issueNotificationAddress(stage: StageName) {
    return Stages[kindOf(stage)].volumeAlert || stage === "prod"
      ? Option.some(yield* Config.schema(EmailAddress, "ISSUE_NOTIFICATION_EMAIL"))
      : Option.none<string>();
  },
);

/**
 * The SQL API query behind the volume alert: invocation rows of `logs.workersLogs` for the
 * account whose `scriptName` is one of `workers`. `logType = 'cf-worker-event'` selects one row
 * per invocation.
 *
 * @param accountId - The deploying account's id.
 * @param workers - The Worker script names to count.
 * @returns The query text.
 */
export const volumeAlertQuery = (accountId: string, workers: ReadonlyArray<string>): string =>
  `SELECT count() AS value FROM logs.workersLogs WHERE accountTag = '${accountId}' AND logType = 'cf-worker-event' AND scriptName IN (${workers.map((name) => `'${name}'`).join(", ")})`;

/**
 * Declare the requests-count volume alert, only where the stage's kind sets `volumeAlert`.
 *
 * It counts invocations of {@link volumeAlertWorkers} per `1 h` window and emails `address` above
 * {@link volumeAlertThreshold} of the `ALLOWANCE_SHARE` and `ALERT_FRACTION` defaults.
 * `ALLOWANCE_SHARE` is a placeholder, not a measurement.
 *
 * @param stage - The decoded stage.
 * @param stack - The stack name.
 * @param address - The `ISSUE_NOTIFICATION_EMAIL` value.
 * @returns Nothing; a stage that declares no alert declares no resource.
 */
export const volumeAlert = Effect.fn("volumeAlert")(function* volumeAlert(
  stage: StageName,
  stack: string,
  address: string,
) {
  if (Stages[kindOf(stage)].volumeAlert) {
    const { accountId } = yield* Cloudflare.CloudflareEnvironment.current;
    const workers = yield* volumeAlertWorkers(stack, stage);

    yield* Cloudflare.Alerting.CustomAlert("VolumeAlert", {
      every: "1h",
      mechanisms: { email: [{ id: address }] },
      name: `${stack}-volume-${stage}`,
      query: volumeAlertQuery(accountId, workers),
      trigger: {
        operator: ">",
        type: "threshold",
        value: volumeAlertThreshold(AllowanceShareKnob.default, AlertFractionKnob.default),
        window: "1h",
      },
    });
  }
});

/**
 * The SQL API query behind the rate-limit error alert: log rows of `logs.workersLogs` for the
 * account whose `scriptName` is `script` and whose `attributes` JSON column has the top-level key
 * `message` equal to `web.ratelimit.error`: `web` logs the event through `Effect.logError` under
 * `structuredLogs`, which hands `console.error` an object whose `message` is the event name. The
 * SQL API reads a `Json` column by exact key and supports no JSON functions, so it rejects
 * `JSONExtractString` (Error 17203).
 *
 * @param accountId - The deploying account's id.
 * @param script - The `web` Worker script name.
 * @returns The query text.
 */
export const rateLimitErrorQuery = (accountId: string, script: string): string =>
  `SELECT count() AS value FROM logs.workersLogs WHERE accountTag = '${accountId}' AND scriptName = '${script}' AND attributes['message'] = 'web.ratelimit.error'`;

/**
 * Declare the `web.ratelimit.error` alert, only where the stage's kind sets `volumeAlert`.
 *
 * It counts {@link rateLimitErrorQuery} rows per `5m` window (300 s, which the pinned resource
 * accepts as `${number}m`), evaluated every `5m`, and emails `address` above `0`.
 *
 * @param stage - The decoded stage.
 * @param stack - The stack name.
 * @param address - The `ISSUE_NOTIFICATION_EMAIL` value.
 * @returns Nothing; a stage that declares no alert declares no resource.
 */
export const rateLimitErrorAlert = Effect.fn("rateLimitErrorAlert")(function* rateLimitErrorAlert(
  stage: StageName,
  stack: string,
  address: string,
) {
  if (Stages[kindOf(stage)].volumeAlert) {
    const { accountId } = yield* Cloudflare.CloudflareEnvironment.current;
    const script = yield* workerName({ stack, stage, worker: "web" });

    yield* Cloudflare.Alerting.CustomAlert("RateLimitErrorAlert", {
      every: "5m",
      mechanisms: { email: [{ id: address }] },
      name: `${stack}-ratelimit-error-${stage}`,
      query: rateLimitErrorQuery(accountId, script),
      trigger: { operator: ">", type: "threshold", value: 0, window: "5m" },
    });
  }
});

/**
 * The domain consumers the projection failure alert watches, one alert each. Each name is the
 * `consumer` its handler writes on its `domain.run.failed` line in `api`.
 */
export const ProjectionConsumers = ["NoteIndex"] as const;

/**
 * The failed runs per `15m` window above which a consumer's projection failure alert fires. A
 * failed run is retried, so a handler that keeps failing passes it within one window.
 */
export const PROJECTION_FAILURE_THRESHOLD = 2;

/**
 * The SQL API query behind the projection failure alert: log rows of `logs.workersLogs` for the
 * account whose `scriptName` is `script` and whose `attributes` JSON column has `event` equal to
 * `domain.run.failed` and `consumer` equal to `consumer`. The package's `domain.runs` metric never
 * reaches Workers Logs, so the alert counts the line the handler writes instead.
 *
 * @param accountId - The deploying account's id.
 * @param script - The `api` Worker script name.
 * @param consumer - The consumer name, an entry of {@link ProjectionConsumers}.
 * @returns The query text.
 */
export const projectionFailureQuery = (
  accountId: string,
  script: string,
  consumer: string,
): string =>
  `SELECT count() AS value FROM logs.workersLogs WHERE accountTag = '${accountId}' AND scriptName = '${script}' AND attributes['event'] = 'domain.run.failed' AND attributes['consumer'] = '${consumer}'`;

/**
 * Declare one projection failure alert per entry of {@link ProjectionConsumers}, only where the
 * stage's kind sets `volumeAlert`.
 *
 * Each counts {@link projectionFailureQuery} rows per `15m` window, evaluated every `15m`, and
 * emails `address` above {@link PROJECTION_FAILURE_THRESHOLD}.
 *
 * @param stage - The decoded stage.
 * @param stack - The stack name.
 * @param address - The `ISSUE_NOTIFICATION_EMAIL` value.
 * @returns Nothing; a stage that declares no alert declares no resource.
 */
export const projectionFailureAlert = Effect.fn("projectionFailureAlert")(
  function* projectionFailureAlert(stage: StageName, stack: string, address: string) {
    if (Stages[kindOf(stage)].volumeAlert) {
      const { accountId } = yield* Cloudflare.CloudflareEnvironment.current;
      const script = yield* workerName({ stack, stage, worker: "api" });

      for (const consumer of ProjectionConsumers) {
        yield* Cloudflare.Alerting.CustomAlert(`ProjectionFailureAlert-${consumer}`, {
          every: "15m",
          mechanisms: { email: [{ id: address }] },
          name: `${stack}-projection-failure-${consumer}-${stage}`,
          query: projectionFailureQuery(accountId, script, consumer),
          trigger: {
            operator: ">",
            type: "threshold",
            value: PROJECTION_FAILURE_THRESHOLD,
            window: "15m",
          },
        });
      }
    }
  },
);

/**
 * Declare the Workers Issues notification on `prod` only: one email policy and one automation for
 * each of `web`, `api` and `auth` that notifies at the first occurrence of an issue.
 *
 * Each automation's `service` is the declared Worker's own name output, so it depends on that
 * Worker and never covers the whole account.
 *
 * @param stage - The decoded stage.
 * @param stack - The stack name.
 * @param address - The `ISSUE_NOTIFICATION_EMAIL` value.
 * @param workers - The declared Worker resources, keyed by their `Workers` entry.
 * @returns Nothing; every other stage declares no resource.
 */
export const prodIssueNotification = Effect.fn("prodIssueNotification")(
  function* prodIssueNotification(
    stage: StageName,
    stack: string,
    address: string,
    workers: Readonly<Record<(typeof Workers)[number], { readonly workerName: Input<string> }>>,
  ) {
    if (stage !== "prod") {
      return;
    }

    const policy = yield* Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
      alertType: "workers_observability_real_time_issue",
      mechanisms: { email: [{ id: address }] },
      name: `${stack}-issues-${stage}`,
    });

    for (const worker of Workers) {
      const name = yield* workerName({ stack, stage, worker });

      yield* Cloudflare.Workers.IssueAutomation(`Issues-${worker}`, {
        afterOccurrences: 1,
        name: `${name}-issues`,
        policyId: policy.policyId,
        service: workers[worker].workerName,
      });
    }
  },
);
