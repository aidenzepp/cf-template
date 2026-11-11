import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Layer, Option, Schema } from "effect";
import { Digest } from "effect/crypto";
import { APP_DB_ID, declareDatabase as declareAppDb } from "../apps/api/src/db/database.ts";
// block:budget-guard start
import { guardNamespace, resources } from "@workspace/budget-guard/stack";
// block:budget-guard end
import { knobsNamespace } from "@workspace/knobs-kv/live";
import { Stage, stageValues } from "./stages.ts";
import {
  issueNotificationAddress,
  prodIssueNotification,
  rateLimitErrorAlert,
  volumeAlert,
} from "./src/alerts.ts";
import { declareApi } from "./src/api.ts";
import { AUTH_DB_ID } from "../apps/auth/src/db/database.ts";
import { declareAuth } from "./src/auth.ts";
import { guardLocationHints } from "./src/d1-hint-guard.ts";
// block:budget-guard start
import { guardPlan } from "./src/guard-plan.ts";
// block:budget-guard end
import { d1LocationHint } from "./src/d1-location.ts";
import { usesProjectState } from "./src/state-selection.ts";
import { publicOrigin } from "./src/origin.ts";
import { declareWeb } from "./src/web.ts";
import { StackNameError, requiresStackNamePin, resolveStackName } from "./src/stack-name.ts";

/**
 * The refusal of stage `prod` outside CI.
 *
 * A stack file cannot tell the phases apart, so the refusal covers every phase and `phase` names
 * them all.
 */
export class ProdStageRefused extends Schema.TaggedError<ProdStageRefused>()("ProdStageRefused", {
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

  yield* guardLocationHints([APP_DB_ID, AUTH_DB_ID], hint);
  yield* declareAppDb(stack, stage, hint);

  // block:knobs-kv start
  const knobs = yield* knobsNamespace(stack, stage);

  // block:knobs-kv end
  // block:budget-guard start
  const guard = yield* guardPlan({ stack, stage });
  yield* resources(guard);
  // block:budget-guard end

  const origin = yield* publicOrigin({ stack, stage });
  const auth = yield* declareAuth({ stack, stage }, hint, values, origin);
  const api = yield* declareApi({ stack, stage }, values);

  const web = yield* declareWeb({ stack, stage }, { api, auth, knobs }, origin, [
    // block:budget-guard start
    ["GUARD_KV", guardNamespace(guard)],
    // block:budget-guard end
  ]);

  const address = yield* issueNotificationAddress(stage);

  if (Option.isSome(address)) {
    yield* volumeAlert(stage, stack, address.value);
    yield* rateLimitErrorAlert(stage, stack, address.value);
    yield* prodIssueNotification(stage, stack, address.value, { api, auth, web });
  }

  return {};
}).pipe(Effect.orDie);

export default Alchemy.Stack("app", { providers: Cloudflare.providers(), state }, program);
