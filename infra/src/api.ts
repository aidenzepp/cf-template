import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Layer, Path } from "effect";
import type { Auth } from "../../apps/auth/src/contract.ts";
import ApiWorkerImpl, { ApiDeployment, ApiWorker } from "../../apps/api/src/worker.ts";
import { workerName } from "../stages.ts";
import type { StageName, StageValues } from "../stages.ts";
import { compat } from "./compat.ts";

/**
 * Declare the `api` Worker with its bindings.
 *
 * The Worker binds `auth` as `AUTH` through its service binding, and the three values
 * `AUTH_CHECK_SESSION_TIMEOUT_MS`, `PROBLEM_DETAILS_INCLUDE` and `EXAMPLE_FEATURE_ENABLED` from the
 * stage's row. It keeps no `workers.dev` address, domain or route: `web` forwards `/api/*` to it.
 * The service binding is made by the Worker's own program.
 *
 * @param identity - The stack name and decoded stage.
 * @param identity.stack - The stack name from `resolveStackName`.
 * @param identity.stage - The decoded stage.
 * @param values - The knob values of the stage.
 * @param auth - The declared `auth` Worker resource that `api` binds.
 * @returns The `api` Worker resource.
 */
export const declareApi = Effect.fn("declareApi")(function* declareApi(
  identity: { readonly stack: string; readonly stage: StageName },
  values: StageValues,
  auth: Effect.Success<typeof Auth>,
) {
  const { stack, stage } = identity;
  const path = yield* Path.Path;
  const main = yield* path.fromFileUrl(new URL("../../apps/api/src/worker.ts", import.meta.url));

  const props = {
    compatibility: { date: compat.date, flags: compat.flags.map((flag) => flag.name) },
    env: {
      AUTH_CHECK_SESSION_TIMEOUT_MS: values.AUTH_CHECK_SESSION_TIMEOUT_MS,
      EXAMPLE_FEATURE_ENABLED: values.EXAMPLE_FEATURE_ENABLED,
      LOG_LEVEL: values.LOG_LEVEL,
      PROBLEM_DETAILS_INCLUDE: values.PROBLEM_DETAILS_INCLUDE,
    },
    main,
    name: yield* workerName({ stack, stage, worker: "api" }),
    workersDev: false,
  } satisfies Cloudflare.WorkerProps;

  return yield* ApiWorker.pipe(
    Effect.provide(
      ApiWorkerImpl.pipe(Layer.provide(Layer.succeed(ApiDeployment, { auth, props }))),
    ),
  );
});
