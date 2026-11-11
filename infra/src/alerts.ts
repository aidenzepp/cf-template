import * as Cloudflare from "@alchemy.run/cloudflare";
import { Config, Effect, Option } from "effect";
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
): Effect.Effect<readonly string[], WorkerNameTooLongError> =>
  Effect.all(Workers.map((worker) => workerName({ stack, stage, worker }))).pipe(
    Effect.map((names) => [...names, `${stack}-state`]),
  );

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
      ? Option.some(yield* Config.String("ISSUE_NOTIFICATION_EMAIL"))
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
export const volumeAlertQuery = (accountId: string, workers: readonly string[]): string =>
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
 * Declare the Workers Issues notification on `prod` only: one email policy and one automation for
 * each of `web`, `api` and `auth` that notifies at the first occurrence of an issue.
 *
 * @param stage - The decoded stage.
 * @param stack - The stack name.
 * @param address - The `ISSUE_NOTIFICATION_EMAIL` value.
 * @returns Nothing; every other stage declares no resource.
 */
export const prodIssueNotification = Effect.fn("prodIssueNotification")(
  function* prodIssueNotification(stage: StageName, stack: string, address: string) {
    if (stage !== "prod") {
      return;
    }

    const policy = yield* Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
      alertType: "workers_observability_real_time_issue",
      mechanisms: { email: [{ id: address }] },
      name: `${stack}-issues-${stage}`,
    });

    for (const worker of Workers) {
      const service = yield* workerName({ stack, stage, worker });

      yield* Cloudflare.Workers.IssueAutomation(`Issues-${worker}`, {
        afterOccurrences: 1,
        name: `${service}-issues`,
        policyId: policy.policyId,
        service,
      });
    }
  },
);
