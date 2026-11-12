import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Layer, Path } from "effect";
import ApiWorkerImpl, { ApiDeployment, ApiWorker } from "../../apps/api/src/worker.ts";
import { limitKnobs, limitsFor } from "@workspace/config/limits";
import { kindOf, workerName } from "../stages.ts";
import type { StageName, StageValues } from "../stages.ts";
import { compat } from "./compat.ts";
import { issuesObservability, telemetryOptions } from "./telemetry.ts";

/**
 * Declare the `api` Worker with its bindings.
 *
 * The Worker binds `auth` as `AUTH` through its service binding, the app D1 database that
 * `alchemy.run.ts` declares as `AppDb` with its migrations (the Worker's own program finds it by
 * that id), the four values `API_DOCS_ENABLED`, `AUTH_CHECK_SESSION_TIMEOUT_MS`,
 * `PROBLEM_DETAILS_INCLUDE` and `EXAMPLE_FEATURE_ENABLED` from the stage's row, and
 * `API_DOCS_LIVE_READ`, which is `false` on `prod` alone. It keeps no
 * `workers.dev` address, domain or route: `web` forwards `/api/*` to it. Both bindings are made by
 * the Worker's own program.
 *
 * @param identity - The stack name and decoded stage.
 * @param identity.stack - The stack name from `resolveStackName`.
 * @param identity.stage - The decoded stage.
 * @param values - The knob values of the stage.
 * @returns The `api` Worker resource.
 */
export const declareApi = Effect.fn("declareApi")(function* declareApi(
  identity: { readonly stack: string; readonly stage: StageName },
  values: StageValues,
) {
  const { stack, stage } = identity;
  const path = yield* Path.Path;
  const main = yield* path.fromFileUrl(new URL("../../apps/api/src/worker.ts", import.meta.url));
  const knobs = yield* limitKnobs;

  const props = {
    compatibility: { date: compat.date, flags: compat.flags.map((flag) => flag.name) },
    env: {
      API_DOCS_ENABLED: values.API_DOCS_ENABLED,
      API_DOCS_LIVE_READ: kindOf(stage) !== "prod",
      AUTH_CHECK_SESSION_TIMEOUT_MS: values.AUTH_CHECK_SESSION_TIMEOUT_MS,
      // block:notes start
      EXAMPLE_FEATURE_ENABLED: values.EXAMPLE_FEATURE_ENABLED,
      // block:notes end
      LOG_LEVEL: values.LOG_LEVEL,
      PROBLEM_DETAILS_INCLUDE: values.PROBLEM_DETAILS_INCLUDE,
    },
    limits: limitsFor("api", { ...knobs, scrypt: values.AUTH_PASSWORD_SCRYPT }),
    main,
    name: yield* workerName({ stack, stage, worker: "api" }),
    observability: issuesObservability,
    workersDev: false,
  } satisfies Cloudflare.WorkerProps;

  const telemetry = telemetryOptions(stage);

  return yield* ApiWorker.pipe(
    Effect.provide(
      ApiWorkerImpl.pipe(Layer.provide(Layer.succeed(ApiDeployment, { props, telemetry }))),
    ),
  );
});
