import { BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Schema } from "effect";
import { Digest } from "effect/crypto";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { awaitAuthReady } from "../../infra/scripts/smoke.ts";
import { APP_STACK_ENTRY } from "../../infra/src/app-stack.ts";
import { publicOrigin } from "../../infra/src/origin.ts";
import { resolveStackName } from "../../infra/src/stack-name.ts";
import { CLOUD_STAGE, Stage } from "../../infra/stages.ts";

/**
 * The refusal to start the cloud suite, raised before any `alchemy` command runs.
 */
class CloudStageRefused extends Schema.TaggedError<
  CloudStageRefused,
  { readonly brand: unique symbol }
>()("CloudStageRefused", {
  message: Schema.String,
}) {}

/**
 * The failure of an `alchemy` child process that ran and exited non-zero.
 */
class AlchemyExited extends Schema.TaggedError<AlchemyExited, { readonly brand: unique symbol }>()(
  "AlchemyExited",
  {
    code: Schema.Finite,
    message: Schema.String,
  },
) {}

/**
 * Decode `ALCHEMY_TEST_STAGE` with the stack's stage Schema and require exactly `test-ci`.
 *
 * Nothing in this module starts a process before this Effect succeeds, so a missing, malformed or
 * other stage fails with the decode message and no deploy.
 *
 * @returns The stage, `test-ci`, or the decode failure or a {@link CloudStageRefused}.
 */
const cloudStage = Effect.fn("cloudStage")(function* cloudStage() {
  const raw = yield* Config.String("ALCHEMY_TEST_STAGE").pipe(Config.withDefault(""));
  const stage = yield* Schema.decodeEffect(Stage)(raw);

  return stage === CLOUD_STAGE
    ? stage
    : yield* new CloudStageRefused({
        message: `test:cloud deploys only ${CLOUD_STAGE}; ALCHEMY_TEST_STAGE is ${stage}. Set ALCHEMY_TEST_STAGE=${CLOUD_STAGE}.`,
      });
});

/**
 * Run `bun run alchemy <phase> infra/alchemy.run.ts --stage <stage>` with its output inherited.
 *
 * @param phase - `deploy` or `destroy`.
 * @param stage - The validated stage.
 * @returns Nothing, or an {@link AlchemyExited} when the command exits non-zero.
 */
const alchemy = Effect.fn("alchemy")(function* alchemy(phase: "deploy" | "destroy", stage: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const code = yield* spawner.exitCode(
    ChildProcess.make(
      "bun",
      ["run", "alchemy", phase, APP_STACK_ENTRY, "--stage", stage, "--yes"],
      {
        stderr: "inherit",
        stdout: "inherit",
      },
    ),
  );

  return code === 0
    ? code
    : yield* new AlchemyExited({
        code,
        message: `alchemy ${phase} --stage ${stage} exited with code ${code}.`,
      });
});

/**
 * Deploy the stage and run `ready` against it, and destroy the stage when either fails, so a failed
 * setup leaves no stage behind for the next run to deploy over. Vitest registers the teardown only
 * after setup returns, so without this a failed deploy is never cleaned up. A destroy that fails
 * too is logged; the deploy's or readiness check's error is the one returned.
 *
 * @param stage - The validated stage.
 * @param ready - The check that the deployed stage serves requests, run after a successful deploy.
 * @returns Nothing, or the deploy's {@link AlchemyExited} or the readiness check's failure.
 */
export const deployOrDestroy = Effect.fn("deployOrDestroy")(function* deployOrDestroy<E, R>(
  stage: string,
  ready: Effect.Effect<void, E, R>,
) {
  yield* alchemy("deploy", stage).pipe(
    Effect.andThen(ready),
    Effect.tapError(() =>
      alchemy("destroy", stage).pipe(
        Effect.catch((error) =>
          Effect.logError(`The cleanup destroy of ${stage} failed too: ${error.message}`),
        ),
      ),
    ),
  );
});

const services = Layer.mergeAll(BunServices.layer, Digest.layerWebCrypto);

/**
 * Wait until the deployed stage's public origin serves `/auth/ok`, so the first test request does
 * not reach a Worker route that still answers 404 after its create (cloud run 43905474970).
 *
 * @param stage - The validated stage.
 * @returns Nothing once the stage answers, or the origin or readiness failure.
 */
const stageReady = Effect.fn("stageReady")(function* stageReady(stage: typeof Stage.Type) {
  const origin = yield* publicOrigin({ stack: yield* resolveStackName(), stage });

  yield* awaitAuthReady(origin);
});

/**
 * Vitest's global setup for the cloud suite: validate the stage, deploy it, wait until it serves
 * requests, and return the teardown that destroys it.
 *
 * @returns The teardown function Vitest calls after the last cloud test.
 */
export default async function setup() {
  const stage = await Effect.runPromise(cloudStage().pipe(Effect.provide(services)));

  await Effect.runPromise(
    deployOrDestroy(stage, stageReady(stage)).pipe(
      Effect.provide(Layer.mergeAll(services, FetchHttpClient.layer)),
    ),
  );

  return () => Effect.runPromise(alchemy("destroy", stage).pipe(Effect.provide(services)));
}
