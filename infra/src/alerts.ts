import * as Cloudflare from "@alchemy.run/cloudflare";
import type { Input } from "alchemy/Input";
import { Config, Effect, Option, Schema } from "effect";
import { Workers } from "../stages.ts";
import type { StageName } from "../stages.ts";
import { workerName } from "../worker-names.ts";

/**
 * An email address as far as the plan can check it: one `@`, a non-empty local part and domain,
 * and no whitespace.
 */
const EmailAddress = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/u));

/**
 * The runbook row that sets `ISSUE_NOTIFICATION_EMAIL`.
 */
export const ISSUE_NOTIFICATION_STEP =
  "docs/spin-up.md, Per project, before the first deploy, step 9";

/**
 * `prod` found no usable `ISSUE_NOTIFICATION_EMAIL`: the variable is unset,
 * empty or not an email address. The message names the variable, the stage and the runbook step,
 * never the value.
 */
class IssueNotificationEmailError extends Schema.TaggedError<
  IssueNotificationEmailError,
  { readonly brand: unique symbol }
>()("IssueNotificationEmailError", {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

/**
 * Read the stack input `ISSUE_NOTIFICATION_EMAIL` on `prod` only, where Workers Issues email it.
 * Every other stage never reads the variable.
 *
 * @param stage - The decoded stage.
 * @returns The address, or none on every stage but `prod`; an {@link IssueNotificationEmailError}
 *   when `prod` has no valid address.
 */
export const issueNotificationAddress = Effect.fn("issueNotificationAddress")(
  function* issueNotificationAddress(stage: StageName) {
    if (stage !== "prod") {
      return Option.none<string>();
    }

    const address = yield* Config.schema(EmailAddress, "ISSUE_NOTIFICATION_EMAIL").pipe(
      Effect.mapError(
        (cause) =>
          new IssueNotificationEmailError({
            cause,
            message: `ISSUE_NOTIFICATION_EMAIL is not set or is not an email address: stage ${stage} emails Workers Issues to it (infra/src/alerts.ts). Set it in the environment for a local deploy, or as the repository secret for CI. See ${ISSUE_NOTIFICATION_STEP}.`,
          }),
      ),
    );

    return Option.some(address);
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
