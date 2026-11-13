import * as Cloudflare from "@alchemy.run/cloudflare";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Alchemy from "alchemy";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import * as Interaction from "alchemy/Interaction";
import { State, StateStoreError, isResourceState } from "alchemy/State";
import {
  Cause,
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
  Predicate,
  Redacted,
  Result,
  Schema,
  Stdio,
} from "effect";
import { Digest } from "effect/crypto";
import { FetchHttpClient } from "effect/http";
import { EMAIL_KEY_SECRET_ID, emailKey } from "../../apps/auth/src/email-key.ts";
import { requiresStackNamePin, resolveStackName } from "../../infra/src/stack-name.ts";
import { STATE_STACK, usesProjectState } from "../../infra/src/state-selection.ts";
import { Stage } from "../../infra/stages.ts";

/**
 * The usage of the command, shown with every argument failure.
 */
const USAGE =
  "Usage: bun run log-key --stage <stage> <email>. For prod a maintainer sets CI=true locally; " +
  "never run it in a workflow, whose log would show the hash.";

/**
 * The refusal of a request: it is not `--stage <stage> <email>`, it targets `prod` outside CI, or
 * the stage's state holds no email key secret.
 */
export class LogKeyRefused extends Schema.TaggedError<LogKeyRefused>()("LogKeyRefused", {
  message: Schema.String,
}) {}

/**
 * One parsed command line.
 */
export interface LogKeyRequest {
  readonly email: string;
  readonly stage: string;
}

/**
 * Parse the arguments after `bun tools/log-key/log-key.ts`.
 *
 * @param args - The raw arguments.
 * @returns The request, or a {@link LogKeyRefused}.
 */
export const parseRequest = (
  args: ReadonlyArray<string>,
): Effect.Effect<LogKeyRequest, LogKeyRefused> => {
  const flag = args.indexOf("--stage");
  const stage = flag === -1 ? "" : (args[flag + 1] ?? "");
  const rest = args.filter((_, index) => index !== flag && index !== flag + 1);
  const [email = ""] = rest;

  return stage !== "" && !stage.startsWith("--") && rest.length === 1 && !email.startsWith("--")
    ? Effect.succeed({ email, stage })
    : Effect.fail(new LogKeyRefused({ message: `Arguments are not a log-key command. ${USAGE}` }));
};

/**
 * Alchemy's `CI` setting, forced on for the state layer. Its provisioning policy
 * (`alchemy/State/Provisioning`) deploys a missing store, or upgrades an outdated one, only outside
 * CI; in CI it fails with a `StateStoreError` that names the bootstrap command, before any deploy.
 */
export const ciPolicy = ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ CI: "true" }), {
  asPrimary: true,
});

/**
 * Turn the refusal of a store that is missing or outdated into a {@link LogKeyRefused}; any other
 * fault stays a defect.
 */
export const refuseUnboundStore = <A, R>(effect: Effect.Effect<A, never, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = Cause.findDefect(cause);

      return Result.isSuccess(defect) &&
        defect.success instanceof StateStoreError &&
        defect.success.requires !== undefined
        ? Effect.fail(
            new LogKeyRefused({
              message: `No usable state store; log-key never deploys one, so run the bootstrap first. ${defect.success.message}`,
            }),
          )
        : Effect.failCause(cause);
    }),
  );

/**
 * The store that holds the stage's records, as the stack program selects it: the project's
 * Cloudflare store for `prod`, `staging-<N>` and `test-ci`, Alchemy local state otherwise.
 *
 * The undocumented subpath `alchemy/Auth/Registry` (`AuthProvidersLive`) supplies the same
 * authentication the `alchemy` command uses. This command opens no profile, token or credential
 * file itself; Alchemy's state layer reads the profile and the store credentials.
 *
 * The state layer runs under {@link ciPolicy}, so a missing or outdated store is refused instead
 * of deployed or upgraded.
 *
 * @param stage - The decoded stage.
 * @returns A layer providing `State`.
 */
const stateOf = Effect.fn("logKey.stateOf")(function* stateOf(stage: typeof Stage.Type) {
  if (!usesProjectState(stage)) {
    return Alchemy.localState().pipe(Layer.provide(BunServices.layer));
  }

  const stack = requiresStackNamePin(stage)
    ? yield* Config.String("STACK_NAME")
    : yield* resolveStackName();

  return Cloudflare.state({ workerName: `${stack}-state` }).pipe(
    Layer.provide(ciPolicy),
    Layer.provide(
      Layer.mergeAll(
        BunServices.layer,
        AuthProvidersLive,
        FetchHttpClient.layer,
        // The store reports its own progress on this renderer; stderr keeps stdout to the hash.
        Interaction.layerNonInteractive({ stdout: process.stderr }),
      ),
    ),
  );
});

/**
 * Check the stage and build the layer that reads its state. `prod` is refused unless `CI=true`,
 * before any store is reached.
 *
 * @param rawStage - The `--stage` value.
 * @returns The decoded stage and the layer, or a failure before any read.
 */
export const resolveTarget = Effect.fn("logKey.resolveTarget")(function* resolveTarget(
  rawStage: string,
) {
  const stage = yield* Schema.decodeUnknownEffect(Stage)(rawStage).pipe(
    Effect.provide(Digest.layerWebCrypto),
  );

  const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));

  if (stage === "prod" && !ci) {
    return yield* new LogKeyRefused({
      message:
        "Stage prod is refused unless CI=true. A maintainer sets CI=true on purpose for a local " +
        "prod lookup; no workflow may run log-key, because its log would print the hash.",
    });
  }

  return { stage, state: yield* stateOf(stage) };
});

/**
 * The keyed hash of `email` under the secret the stage's state records for `auth`. The secret is
 * read through the `State` service and never printed or returned.
 *
 * @param stage - The decoded stage.
 * @param email - The address as typed.
 * @returns The hash the `auth` Worker logs as `emailKey` for the same address.
 */
export const keyFor = Effect.fn("logKey.keyFor")(function* keyFor(stage: string, email: string) {
  const persisted = yield* (yield* State).pipe(
    refuseUnboundStore,
    Effect.flatMap((store) => store.get({ fqn: EMAIL_KEY_SECRET_ID, stack: STATE_STACK, stage })),
  );

  const held: unknown = isResourceState(persisted) ? persisted.attr?.text : undefined;
  const text = Redacted.isRedacted(held) ? Redacted.value(held) : undefined;

  if (!Predicate.isString(text)) {
    return yield* new LogKeyRefused({
      message: `Stage ${stage} records no ${EMAIL_KEY_SECRET_ID}. Deploy the stage first.`,
    });
  }

  return yield* emailKey(Redacted.make(text), email);
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const request = yield* parseRequest(yield* (yield* Stdio.Stdio).args);
      const target = yield* resolveTarget(request.stage);

      yield* Console.log(
        yield* keyFor(target.stage, request.email).pipe(Effect.provide(target.state)),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
