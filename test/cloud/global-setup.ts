import { BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Schema } from "effect";
import { Digest } from "effect/crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Stage } from "../../infra/stages.ts";

/**
 * The only stage `test:cloud` deploys: fixed, serialized, and kept in the project state store.
 */
const CLOUD_STAGE = "test-ci";

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
    ChildProcess.make("bun", ["run", "alchemy", phase, "infra/alchemy.run.ts", "--stage", stage], {
      stderr: "inherit",
      stdout: "inherit",
    }),
  );

  return code === 0
    ? code
    : yield* new AlchemyExited({
        code,
        message: `alchemy ${phase} --stage ${stage} exited with code ${code}.`,
      });
});

const services = Layer.mergeAll(BunServices.layer, Digest.layerWebCrypto);

/**
 * Vitest's global setup for the cloud suite: validate the stage, deploy it, and return the
 * teardown that destroys it.
 *
 * @returns The teardown function Vitest calls after the last cloud test.
 */
export default async function setup() {
  const stage = await Effect.runPromise(cloudStage().pipe(Effect.provide(services)));

  await Effect.runPromise(alchemy("deploy", stage).pipe(Effect.provide(services)));

  return () => Effect.runPromise(alchemy("destroy", stage).pipe(Effect.provide(services)));
}
