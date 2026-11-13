import { Config, Console, Context, Effect, Schema } from "effect";
import { Digest } from "effect/crypto";
import { Stage } from "../../../infra/stages.ts";
import { requiresStackNamePin, resolveStackName } from "../../../infra/src/stack-name.ts";
import { LATCH_KEY } from "./latch.ts";
import { guardNamespaceTitle } from "./resources.ts";

/**
 * The usage of the command, shown with every argument failure.
 */
const USAGE = "Usage: bun packages/budget-guard/scripts/reset.ts --stage <stage>.";

/**
 * The refusal of a request before any write: the arguments are not `--stage <stage>`, the stage is
 * `prod` outside CI, or the lookup did not find exactly one namespace.
 */
export class GuardResetRefused extends Schema.TaggedError<
  GuardResetRefused,
  { readonly brand: unique symbol }
>()("GuardResetRefused", { message: Schema.String }) {}

/**
 * The failure of a Cloudflare call the command made, with the operation that failed.
 */
export class GuardKvError extends Schema.TaggedError<
  GuardKvError,
  { readonly brand: unique symbol }
>()("GuardKvError", {
  message: Schema.String,
}) {}

/**
 * A namespace the account lists: its id and exact title.
 */
export interface NamespaceRef {
  readonly id: string;
  readonly title: string;
}

/**
 * The calls the reset command makes, and no others.
 */
export interface GuardKvClient {
  /**
   * Every namespace of the account whose title equals `title`.
   */
  readonly findNamespaces: (
    title: string,
  ) => Effect.Effect<ReadonlyArray<NamespaceRef>, GuardKvError>;
  /**
   * Delete `key`; deleting an absent key succeeds.
   */
  readonly remove: (namespaceId: string, key: string) => Effect.Effect<void, GuardKvError>;
}

/**
 * The Cloudflare client of the command. Tests provide a fake; `GuardKvLive` provides the real one.
 */
export class GuardKv extends Context.Service<GuardKv, GuardKvClient>()(
  "@workspace/budget-guard/GuardKv",
) {}

/**
 * Parse the arguments after `bun packages/budget-guard/scripts/reset.ts`.
 *
 * @param args - The raw arguments.
 * @returns The stage, or a {@link GuardResetRefused} unless the arguments are exactly
 *   `--stage <stage>`.
 */
export const parseStage = (
  args: ReadonlyArray<string>,
): Effect.Effect<string, GuardResetRefused> => {
  const [flag, stage, ...extra] = args;

  return flag === "--stage" && stage !== undefined && !stage.startsWith("--") && extra.length === 0
    ? Effect.succeed(stage)
    : Effect.fail(
        new GuardResetRefused({ message: `Arguments are not a reset command. ${USAGE}` }),
      );
};

/**
 * Clear the latch of a stage: refuse `prod` unless `CI=true`, derive the stack name, find the one
 * namespace titled `<stack>-<stage>-guard` and delete its `state` key.
 *
 * Every refusal happens before the first client call, and a lookup of zero or several namespaces
 * writes nothing.
 *
 * @param rawStage - The `--stage` value.
 * @returns Nothing, after printing the namespace id, its title and the result.
 */
export const resetGuard = Effect.fn("budgetGuard.reset")(function* resetGuard(rawStage: string) {
  const stage = yield* Schema.decodeUnknownEffect(Stage)(rawStage).pipe(
    Effect.provide(Digest.layerWebCrypto),
  );

  const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));

  if (stage === "prod" && !ci) {
    return yield* new GuardResetRefused({
      message: "Stage prod is refused unless CI=true. Run a prod reset from the CI workflow.",
    });
  }

  const stack = requiresStackNamePin(stage)
    ? yield* Config.String("STACK_NAME")
    : yield* resolveStackName();

  const title = guardNamespaceTitle(stack, stage);
  const client = yield* GuardKv;
  const matches = yield* client.findNamespaces(title);
  const [only] = matches;

  if (only === undefined || matches.length > 1) {
    return yield* new GuardResetRefused({
      message: `Expected exactly one namespace titled ${title}, found ${matches.length}. Nothing was deleted.`,
    });
  }

  yield* client.remove(only.id, LATCH_KEY);

  return yield* Console.log(`namespace ${only.id} ${only.title}: deleted key ${LATCH_KEY}`);
});
