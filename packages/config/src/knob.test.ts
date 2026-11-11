import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  Exit,
  Logger,
  Option,
  Predicate,
  References,
  Schema,
} from "effect";
import { fromSource, Knob, LiveKnobs, MissingKnobAnnotationError } from "./knob.ts";
import type { LiveSource } from "./knob.ts";

/**
 * A log line as the test logger captures it: its level and the `knob.MODE.reason` annotation.
 */
interface Captured {
  readonly level: string;
  readonly reason: string | undefined;
}

const Mode = Schema.Literals(["fast", "slow"]).annotate({
  default: "fast",
  description: "How fast the test subject runs.",
});

const ModeKnob = Knob.make("MODE", Mode);

/**
 * Provide a tier (b) environment made of `values`, never touching the host environment.
 */
const withEnv = (values: Readonly<Record<string, string>>) =>
  Effect.provide(
    ConfigProvider.layer(ConfigProvider.fromUnknown({ UNRELATED: "present", ...values })),
  );

/**
 * Run `effect` and return its result together with every log line it emitted.
 */
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* capture() {
    const lines: Array<Captured> = [];

    const logger = Logger.make(({ fiber, logLevel }) => {
      const reason = fiber.getRef(References.CurrentLogAnnotations)["knob.MODE.reason"];

      lines.push({ level: logLevel, reason: Predicate.isString(reason) ? reason : undefined });
    });

    const value = yield* effect.pipe(Effect.provide(Logger.layer([logger])));

    return { lines, value };
  });

/**
 * A live source that answers every read with `value`.
 */
const sourceOf = (value: string): LiveSource => ({
  name: "test-source",
  read: () => Effect.succeed(Option.some(value)),
});

/**
 * Construct a knob from `schema` and return the defect `Knob.make` raised.
 */
const defectOf = (schema: Schema.Codec<string>) =>
  Effect.try({ catch: (error) => error, try: () => Knob.make("BARE", schema) }).pipe(Effect.flip);

describe("Knob.make", () => {
  it.effect("applies the default when the key is absent", () =>
    Effect.gen(function* step1() {
      assert.strictEqual(yield* ModeKnob.config, "fast");
    }).pipe(withEnv({})),
  );

  it.effect("reads an empty string as absent", () =>
    Effect.gen(function* step2() {
      assert.strictEqual(yield* ModeKnob.config, "fast");
    }).pipe(withEnv({ MODE: "" })),
  );

  it.effect("reads a supplied valid value", () =>
    Effect.gen(function* step3() {
      assert.strictEqual(yield* ModeKnob.config, "slow");
    }).pipe(withEnv({ MODE: "slow" })),
  );

  it.effect("fails through the error channel for an invalid value", () =>
    Effect.gen(function* step4() {
      const exit = yield* Effect.exit(ModeKnob.config);

      assert.isTrue(Exit.isFailure(exit));
    }).pipe(withEnv({ MODE: "sideways" })),
  );

  it.effect("dies with MissingKnobAnnotation when description is absent", () =>
    Effect.gen(function* missingDescription() {
      const error = yield* defectOf(Schema.Literals(["a"]).annotate({ default: "a" }));

      assert.instanceOf(error, MissingKnobAnnotationError);
      assert.deepStrictEqual([error.key, error.annotation], ["BARE", "description"]);
    }),
  );

  it.effect("dies with MissingKnobAnnotation when default is absent", () =>
    Effect.gen(function* missingDefault() {
      const error = yield* defectOf(Schema.Literals(["a"]).annotate({ description: "A knob." }));

      assert.instanceOf(error, MissingKnobAnnotationError);
      assert.deepStrictEqual([error.key, error.annotation], ["BARE", "default"]);
    }),
  );
});

describe("LiveKnobs", () => {
  it.effect("annotates no_adapter and yields the tier (b) value on every read", () =>
    Effect.gen(function* step5() {
      const { lines, value: read } = yield* captureLogs(
        Effect.gen(function* step6() {
          const knobs = yield* LiveKnobs;

          return yield* knobs.bind(ModeKnob);
        }),
      );

      assert.strictEqual(yield* read, "slow");
      assert.strictEqual(yield* read, "slow");
      assert.deepStrictEqual(
        lines.map(({ reason }) => reason),
        ["no_adapter"],
      );
    }).pipe(withEnv({ MODE: "slow" })),
  );

  it.effect("fails construction when the tier (b) value is invalid", () =>
    Effect.gen(function* step7() {
      const knobs = yield* LiveKnobs;
      const exit = yield* Effect.exit(knobs.bind(ModeKnob));

      assert.isTrue(Exit.isFailure(exit));
    }).pipe(withEnv({ MODE: "sideways" })),
  );
});

describe("fromSource", () => {
  it.effect("reads a valid live value over the tier (b) value", () =>
    Effect.gen(function* step8() {
      const read = yield* fromSource(sourceOf("slow")).bind(ModeKnob);

      assert.strictEqual(yield* read, "slow");
    }).pipe(withEnv({ MODE: "fast" })),
  );

  it.effect("falls back to tier (b) and logs once per distinct invalid value", () =>
    Effect.gen(function* step9() {
      const { lines, value } = yield* captureLogs(
        Effect.gen(function* step10() {
          const read = yield* fromSource(sourceOf("sideways")).bind(ModeKnob);

          return [yield* read, yield* read];
        }),
      );

      assert.deepStrictEqual(value, ["fast", "fast"]);
      assert.deepStrictEqual(
        lines.map(({ level, reason }) => [level, reason]),
        [["Error", "schema_rejected"]],
      );
    }).pipe(withEnv({})),
  );
});
