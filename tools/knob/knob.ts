import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Clock, Config, Console, Effect, Schema, Stdio } from "effect";
import { Digest } from "effect/crypto";
import { Stage } from "../../infra/stages.ts";
import { requiresStackNamePin, resolveStackName } from "../../infra/src/stack-name.ts";
import { knobsNamespaceTitle } from "../../packages/knobs-kv/src/live.ts";
import { KnobKv, KnobKvLive } from "./alchemy.ts";
import type { NamespaceRef, StoredKey } from "./alchemy.ts";
import { liveKnobs } from "./registry.ts";

/**
 * The usage of the command, shown with every argument failure.
 */
const USAGE =
  "Usage: bun run knob set --stage <stage> <KEY> <value> | unset --stage <stage> <KEY> | status --stage <stage>.";

/**
 * The refusal of a request before any write: it is not one of the three commands, it targets
 * `prod` outside CI, the lookup did not find exactly one namespace, or its key or value is one the
 * registry and the knob's schema refuse.
 */
export class KnobRefused extends Schema.TaggedError<KnobRefused>()("KnobRefused", {
  message: Schema.String,
}) {}

/**
 * The failure of `status` when any stored key is `REJECTED` or `ORPHAN`.
 */
export class KnobStatusFailed extends Schema.TaggedError<KnobStatusFailed>()("KnobStatusFailed", {
  message: Schema.String,
}) {}

/**
 * One parsed command line.
 */
export type KnobRequest = { readonly stage: string } & (
  | { readonly command: "set"; readonly key: string; readonly value: string }
  | { readonly command: "unset"; readonly key: string }
  | { readonly command: "status" }
);

/**
 * Parse the arguments after `bun tools/knob/knob.ts`.
 *
 * @param args - The raw arguments.
 * @returns The request, or a {@link KnobRefused}.
 */
export const parseRequest = (
  args: ReadonlyArray<string>,
): Effect.Effect<KnobRequest, KnobRefused> => {
  const flag = args.indexOf("--stage");
  const stage = flag === -1 ? "" : (args[flag + 1] ?? "");

  const [command, key = "", value = "", ...extra] = args.filter(
    (_, index) => index !== flag && index !== flag + 1,
  );

  if (stage !== "" && !stage.startsWith("--")) {
    if (command === "set" && key !== "" && value !== "" && extra.length === 0) {
      return Effect.succeed({ command, key, stage, value });
    }

    if (command === "unset" && key !== "" && value === "") {
      return Effect.succeed({ command, key, stage });
    }

    if (command === "status" && key === "") {
      return Effect.succeed({ command, stage });
    }
  }

  return Effect.fail(new KnobRefused({ message: `Arguments are not a knob command. ${USAGE}` }));
};

/**
 * Decode `raw` with the knob's schema. The parameter type forgets the knob's value type, so a
 * registry entry of any value type fits.
 *
 * @param knob - The registry entry.
 * @param knob.decode - The knob's string codec.
 * @param raw - The string form to validate.
 * @returns The decode effect, failing when the schema rejects `raw`.
 */
const check = (
  knob: { readonly decode: (raw: string) => Effect.Effect<unknown, Schema.SchemaError> },
  raw: string,
) => knob.decode(raw);

/**
 * Resolve the namespace a request targets: refuse `prod` unless `CI=true`, derive the stack name,
 * and find the one namespace whose title equals {@link knobsNamespaceTitle}.
 *
 * @param rawStage - The `--stage` value.
 * @returns The namespace, or a failure before any write.
 */
export const resolveNamespace = Effect.fn("knob.resolveNamespace")(function* resolveNamespace(
  rawStage: string,
) {
  const stage = yield* Schema.decodeUnknownEffect(Stage)(rawStage).pipe(
    Effect.provide(Digest.layerWebCrypto),
  );

  const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));

  if (stage === "prod" && !ci) {
    return yield* new KnobRefused({
      message: "Stage prod is refused unless CI=true. Run prod knob changes from the CI workflow.",
    });
  }

  const stack = requiresStackNamePin(stage)
    ? yield* Config.String("STACK_NAME")
    : yield* resolveStackName();

  const title = knobsNamespaceTitle(stack, stage);
  const matches = yield* (yield* KnobKv).findNamespaces(title);
  const [only] = matches;

  if (only === undefined || matches.length > 1) {
    return yield* new KnobRefused({
      message: `Expected exactly one namespace titled ${title}, found ${matches.length}. Nothing was written.`,
    });
  }

  yield* Console.log(`namespace ${only.id} ${only.title}`);

  return only;
});

/**
 * Judge the stored layer: a key outside the registry is `ORPHAN`, a value its knob's schema
 * rejects is `REJECTED`, anything else is `ok`.
 *
 * @param rows - The stored keys.
 * @returns One line per key, in order.
 */
export const reportStored = (rows: ReadonlyArray<StoredKey>) =>
  Effect.all(
    rows.map((row) => {
      const knob = liveKnobs.find((candidate) => candidate.key === row.key);
      const value = JSON.stringify(row.value);

      return knob === undefined
        ? Effect.succeed({ bad: true, line: `${row.key} ORPHAN: it is not in the registry` })
        : Effect.match(check(knob, row.value), {
            onFailure: () => ({
              bad: true,
              line: `${row.key} REJECTED: stored ${value} fails its schema`,
            }),
            onSuccess: () => ({ bad: false, line: `${row.key} ok ${value}` }),
          });
    }),
  );

/**
 * Print the stored layer and fail when any key is `REJECTED` or `ORPHAN`.
 *
 * @param namespace - The namespace to read.
 * @returns Nothing, or a {@link KnobStatusFailed} naming the count.
 */
const status = Effect.fn("knob.status")(function* status(namespace: NamespaceRef) {
  const lines = yield* reportStored(yield* (yield* KnobKv).stored(namespace.id));

  yield* Console.log(
    lines.length === 0 ? "no stored overrides" : lines.map((entry) => entry.line).join("\n"),
  );

  const bad = lines.filter((entry) => entry.bad).length;

  if (bad > 0) {
    yield* new KnobStatusFailed({ message: `${bad} stored key(s) are REJECTED or ORPHAN.` });
  }
});

/**
 * Run one request: resolve the namespace, then `set` (validate, then write), `unset` or `status`.
 *
 * @param request - The parsed command.
 * @returns Nothing, or the first failure; a failed validation writes nothing.
 */
export const execute = Effect.fn("knob.execute")(function* execute(request: KnobRequest) {
  if (request.command === "set" && request.stage === "prod" && request.key === "API_DOCS_ENABLED") {
    return yield* new KnobRefused({
      message:
        "API_DOCS_ENABLED is read at deploy time only on prod. Change it in infra/stages.ts and deploy. Nothing was written.",
    });
  }

  const namespace = yield* resolveNamespace(request.stage);
  const store = yield* KnobKv;

  if (request.command === "status") {
    return yield* status(namespace);
  }

  if (request.command === "unset") {
    yield* store.remove(namespace.id, request.key);

    return yield* Console.log(`unset ${request.key}`);
  }

  const knob = liveKnobs.find((candidate) => candidate.key === request.key);

  if (knob === undefined) {
    return yield* new KnobRefused({
      message: `${request.key} is not a live knob. The live knobs are ${liveKnobs.map((k) => k.key).join(", ")}.`,
    });
  }

  yield* Effect.mapError(
    check(knob, request.value),
    (error) =>
      new KnobRefused({
        message: `${request.value} is not valid for ${request.key}: ${error.message}`,
      }),
  );

  const setAt = new Date(yield* Clock.currentTimeMillis).toISOString();

  yield* store.put(namespace.id, request.key, request.value, { setAt });

  return yield* Console.log(`set ${request.key} ${request.value}`);
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      yield* execute(yield* parseRequest(yield* (yield* Stdio.Stdio).args));
    }).pipe(Effect.provide(KnobKvLive), Effect.provide(BunServices.layer)),
  );
}
