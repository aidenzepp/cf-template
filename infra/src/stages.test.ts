import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Schema } from "effect";
import { Digest } from "effect/crypto";
import { AUTH_PASSWORD_SCRYPT } from "@workspace/config/auth-password";
import { LogLevelKnob } from "@workspace/config/log-level";
import {
  LONGEST_STAGE,
  STACK_NAME_MAX,
  Stage,
  Stages,
  WorkerNameTooLongError,
  Workers,
  kindOf,
  stageValues,
  workerName,
} from "../stages.ts";

/**
 * Decode a stage string with the stage Schema.
 *
 * @param raw - The candidate stage name.
 * @returns The decoding effect.
 */
const decodeStage = (raw: string) =>
  Schema.decodeEffect(Stage)(raw).pipe(Effect.provide(Digest.layerWebCrypto));

describe("Stage", () => {
  it.effect.each(["prod", "staging-1", "staging-123456", "test-ci", "test-abc", "dev"])(
    "decodes %s",
    (raw) =>
      Effect.gen(function* decodes() {
        assert.strictEqual(yield* decodeStage(raw), raw);
      }),
  );

  it.effect.each(["staging-1234567", "Test-abc", "test_abc", "dev-alice", "release"])(
    "rejects %s",
    (raw) =>
      Effect.gen(function* rejects() {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeStage(raw))));
      }),
  );

  it.effect("normalizes a 20-character slug to 14 with a hash tail", () =>
    Effect.gen(function* normalizes() {
      const slug = "abcdefghijklmnopqrst";
      const stage = yield* decodeStage(`test-${slug}`);

      assert.strictEqual(stage.length, "test-".length + 14);
      assert.isTrue(stage.startsWith("test-abcdefgh"));
      assert.match(stage.slice("test-abcdefgh".length), /^[a-z2-7]{6}$/u);
      assert.strictEqual(yield* decodeStage(`test-${slug}`), stage);
    }),
  );

  it("classifies stages by kind", () => {
    assert.strictEqual(kindOf("prod"), "prod");
    assert.strictEqual(kindOf("staging-7"), "staging");
    assert.strictEqual(kindOf("test-ci"), "test");
    assert.strictEqual(kindOf("test-abc"), "test");
    assert.strictEqual(kindOf("dev"), "local");
  });
});

describe("derived bounds", () => {
  it("derives the Workers, the longest stage and the stack-name bound", () => {
    assert.deepStrictEqual(Workers, ["web", "api", "auth"]);
    assert.strictEqual(LONGEST_STAGE, 19);
    assert.strictEqual(STACK_NAME_MAX, 29);
  });

  it.effect("builds a Worker name and fails above 54 characters", () =>
    Effect.gen(function* builds() {
      assert.strictEqual(
        yield* workerName({ stack: "cf-template", stage: "staging-12", worker: "web" }),
        "cf-template-web-staging-12",
      );

      const error = yield* Effect.flip(
        workerName({ stack: "s".repeat(40), stage: "test-abcdefghijklmn", worker: "auth" }),
      );

      assert.instanceOf(error, WorkerNameTooLongError);
    }),
  );
});

describe("Stages", () => {
  it.effect("holds only values the LogLevelKnob codec decodes", () =>
    Effect.gen(function* decodes() {
      for (const values of Object.values(Stages)) {
        const raw = yield* LogLevelKnob.encode(values.LOG_LEVEL);

        assert.strictEqual(yield* LogLevelKnob.decode(raw), values.LOG_LEVEL);
      }
    }),
  );

  it.effect("overrides a test value from STAGES_TEST_LOG_LEVEL only for the test kind", () =>
    Effect.gen(function* overrides() {
      const provider = ConfigProvider.layer(
        ConfigProvider.fromUnknown({ STAGES_TEST_LOG_LEVEL: "Error" }),
      );

      const test = yield* stageValues("test-abc").pipe(Effect.provide(provider));
      const prod = yield* stageValues("prod").pipe(Effect.provide(provider));

      assert.strictEqual(test.LOG_LEVEL, "Error");
      assert.strictEqual(prod.LOG_LEVEL, Stages.prod.LOG_LEVEL);
    }),
  );

  it.effect("overrides every knob from STAGES_TEST_<KEY> on a test stage, not the others", () =>
    Effect.gen(function* overridesEveryKnob() {
      const provider = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          STAGES_TEST_AUTH_CHECK_SESSION_TIMEOUT_MS: "900",
          STAGES_TEST_DOCS_ENABLED: "false",
          STAGES_TEST_HEAD_SAMPLING_RATE: "0.25",
          STAGES_TEST_PROBLEM_DETAILS_INCLUDE: "false",
        }),
      );

      const test = yield* stageValues("test-abc").pipe(Effect.provide(provider));
      const staging = yield* stageValues("staging-1").pipe(Effect.provide(provider));

      assert.strictEqual(test.AUTH_CHECK_SESSION_TIMEOUT_MS, 900);
      assert.strictEqual(test.DOCS_ENABLED, false);
      assert.strictEqual(test.HEAD_SAMPLING_RATE, 0.25);
      assert.strictEqual(test.PROBLEM_DETAILS_INCLUDE, false);
      assert.strictEqual(test.LOG_LEVEL, Stages.test.LOG_LEVEL);
      assert.deepStrictEqual(staging, Stages.staging);
    }),
  );

  it.effect("fails a test stage on an invalid knob override", () =>
    Effect.gen(function* invalidOverride() {
      const provider = ConfigProvider.layer(
        ConfigProvider.fromUnknown({ STAGES_TEST_DOCS_ENABLED: "maybe" }),
      );

      const exit = yield* Effect.exit(stageValues("test-abc").pipe(Effect.provide(provider)));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it("serves the API documentation on every stage kind except prod", () => {
    assert.deepStrictEqual(
      Object.entries(Stages).map(([kind, values]) => [kind, values.DOCS_ENABLED]),
      [
        ["local", true],
        ["prod", false],
        ["staging", true],
        ["test", true],
      ],
    );
  });

  it.effect("binds a scrypt cost the Worker's own config reads back for every kind", () =>
    Effect.gen(function* binds() {
      for (const values of Object.values(Stages)) {
        const bound = yield* AUTH_PASSWORD_SCRYPT.encode(values.AUTH_PASSWORD_SCRYPT);

        const read = yield* AUTH_PASSWORD_SCRYPT.config.pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTH_PASSWORD_SCRYPT: bound })),
          ),
        );

        assert.deepStrictEqual(read, values.AUTH_PASSWORD_SCRYPT);
        assert.deepStrictEqual(values.AUTH_PASSWORD_SCRYPT, AUTH_PASSWORD_SCRYPT.default);
      }
    }),
  );
});
