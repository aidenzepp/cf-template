import { BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Schedule, Schema } from "effect";
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
 * The most times `alchemy deploy` runs for the stage before its failure is final: the first run and
 * two retries.
 */
const DEPLOY_ATTEMPTS = 3;

/**
 * The pause before each repeat of a deploy that exited non-zero.
 *
 * A stage name that was destroyed seconds before it is deployed again fails its first deploy at
 * `Notes.DomainBackfillRun` with `InstanceNotFound`. The backfill in `@alchemy.run/cloudflare`
 * (`Domain/Backfill.ts`, 2.0.0-beta.85) retries `WorkflowNotFound` and `WorkflowInternalError` when
 * it creates the instance, but the `getInstance` that follows retries only
 * `WorkflowInternalError`, so the Workflows API answering not found for an instance on a workflow
 * name recreated moments before ends the deploy. A repeat of the deploy resumes at that resource
 * alone and succeeds once the workflow answers: a repeat started at once failed the same way and
 * one started 15 seconds later succeeded, so each pause is 20 seconds. A deploy that fails for
 * another reason spends 40 seconds on the pauses before it fails.
 */
const DEPLOY_RETRY_PAUSE = "20 seconds";

/**
 * Build the schedule that repeats a failed deploy: one repeat per pause, only for a command that
 * exited non-zero, and no more than {@link DEPLOY_ATTEMPTS} runs in all. Each repeat logs one line
 * naming the attempt that failed and its exit code.
 *
 * A failure that is not {@link AlchemyExited}, such as a process that could not start, is not
 * repeated, and when the attempts run out the last failure is the one returned.
 *
 * @param stage - The validated stage.
 * @returns The retry schedule for `alchemy deploy` on the stage.
 */
const retryDeploy = (stage: string) =>
  Schedule.spaced(DEPLOY_RETRY_PAUSE).pipe(
    Schedule.while(({ attempt, input }) =>
      Schema.is(AlchemyExited)(input) && attempt < DEPLOY_ATTEMPTS
        ? Effect.as(
            Effect.logWarning(
              `Deploy attempt ${attempt} of ${DEPLOY_ATTEMPTS} for ${stage} exited with code ${input.code}; deploying again in ${DEPLOY_RETRY_PAUSE}.`,
            ),
            true,
          )
        : Effect.succeed(false),
    ),
  );

/**
 * Deploy the stage, repeating a deploy that exits non-zero, run `ready` against it, and destroy the
 * stage when either fails, so a failed setup leaves no stage behind for the next run to deploy
 * over. Vitest registers the teardown only after setup returns, so without this a failed deploy is
 * never cleaned up. A destroy that fails too is logged; the deploy's or readiness check's error is
 * the one returned. A readiness failure is not repeated.
 *
 * @param stage - The validated stage.
 * @param ready - The check that the deployed stage serves requests, run after a successful deploy.
 * @returns Nothing, or the last deploy's {@link AlchemyExited} or the readiness check's failure.
 */
export const deployOrDestroy = Effect.fn("deployOrDestroy")(function* deployOrDestroy<E, R>(
  stage: string,
  ready: Effect.Effect<void, E, R>,
) {
  yield* alchemy("deploy", stage).pipe(
    Effect.retry(retryDeploy(stage)),
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
