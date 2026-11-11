import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Layer, Path, Schema } from "effect";
import { Digest } from "effect/crypto";
import { TaggedError as taggedError } from "effect/Schema";
import { declareDatabase as declareAppDb } from "../apps/api/src/db/database.ts";
import { declareDatabase as declareAuthDb } from "../apps/auth/src/db/database.ts";
import { Stage, stageValues, workerName } from "./stages.ts";
import { compat } from "./src/compat.ts";
import { d1LocationHint } from "./src/d1-location.ts";
import { StackNameError, requiresStackNamePin, resolveStackName } from "./src/stack-name.ts";

/**
 * The refusal of stage `prod` outside CI.
 *
 * A stack file cannot tell the phases apart, so the refusal covers every phase and `phase` names
 * them all.
 */
export class ProdStageRefused extends taggedError<ProdStageRefused>()("ProdStageRefused", {
  phase: Schema.String,
  stage: Schema.String,
}) {
  override get message(): string {
    return `Stage ${this.stage} is refused for ${this.phase} unless CI=true. Deploy and destroy prod from the CI workflow, not a laptop.`;
  }
}

/**
 * Decode the raw stage with the stage Schema and refuse `prod` unless `CI=true`.
 *
 * @param raw - The stage the CLI passed.
 * @returns The decoded stage, or a failure before any resource is declared.
 */
export const decodeStage = Effect.fn("decodeStage")(function* decodeStage(raw: string) {
  const stage = yield* Schema.decodeUnknownEffect(Stage)(raw);
  const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));

  return stage === "prod" && !ci
    ? yield* new ProdStageRefused({ phase: "deploy, destroy, dev and plan", stage })
    : stage;
}, Effect.provide(Digest.layerWebCrypto));

/**
 * Decode the stage and resolve the stack name: the pinned `STACK_NAME` where the stage requires
 * it, the derived name otherwise.
 *
 * @param raw - The stage the CLI passed.
 * @returns The decoded stage and the stack name.
 */
export const resolveIdentity = Effect.fn("resolveIdentity")(function* resolveIdentity(raw: string) {
  const stage = yield* decodeStage(raw);

  const stack = requiresStackNamePin(stage)
    ? yield* Config.String("STACK_NAME").pipe(
        Effect.mapError(
          () =>
            new StackNameError({
              message: `STACK_NAME is required for stage ${stage} and is unset. Run the bootstrap stack to record it, or set it to the name \`bun infra/scripts/stack-name.ts\` prints.`,
            }),
        ),
      )
    : yield* resolveStackName();

  return { stack, stage };
});

/**
 * Report whether the stage keeps its state in the project's Cloudflare state store.
 *
 * `prod`, `staging-<N>` and `test-ci` do; `test-<slug>` and `dev` use Alchemy local state.
 *
 * @param stage - The decoded stage.
 * @returns `true` for a stage that uses the project store.
 */
export const usesProjectState = (stage: string): boolean =>
  stage === "prod" || stage === "test-ci" || stage.startsWith("staging-");

const state = Layer.unwrap(
  Effect.gen(function* declareState() {
    const { stack, stage } = yield* resolveIdentity(yield* Alchemy.Stage);

    return usesProjectState(stage)
      ? Cloudflare.state({ workerName: `${stack}-state` })
      : Alchemy.localState();
  }).pipe(Effect.orDie),
);

const program = Effect.gen(function* declareStack() {
  const { stack, stage } = yield* resolveIdentity(yield* Alchemy.Stage);
  const hint = yield* d1LocationHint;
  const values = yield* stageValues(stage);
  const path = yield* Path.Path;

  yield* declareAppDb(stack, stage, hint);
  yield* declareAuthDb(stack, stage, hint);

  const declareWorker = Effect.fn("declareWorker")(function* declareWorker(
    id: "Web" | "Api" | "Auth",
    app: "web" | "api" | "auth",
    workersDev: boolean,
  ) {
    const main = yield* path.fromFileUrl(new URL(`../apps/${app}/src/worker.ts`, import.meta.url));

    return yield* Cloudflare.Worker(id, {
      compatibility: { date: compat.date, flags: compat.flags.map((flag) => flag.name) },
      env: { ...values },
      main,
      name: yield* workerName({ stack, stage, worker: app }),
      workersDev,
    });
  });

  yield* declareWorker("Web", "web", true);
  yield* declareWorker("Api", "api", false);
  yield* declareWorker("Auth", "auth", false);

  return {};
}).pipe(Effect.orDie);

export default Alchemy.Stack("app", { providers: Cloudflare.providers(), state }, program);
