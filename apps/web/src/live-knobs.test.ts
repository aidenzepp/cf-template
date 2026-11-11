import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { LogLevelKnob } from "@workspace/config/log-level";
import { webKnobs } from "./live-knobs.ts";

/**
 * Bind `LOG_LEVEL` over a `KNOBS` binding and read it once.
 */
const levelOver = (
  get: (key: string, options: { readonly cacheTtl: number }) => Promise<string | null>,
) =>
  Effect.gen(function* read() {
    const level = yield* webKnobs({ get }).bind(LogLevelKnob);

    return yield* level;
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))), Effect.orDie);

describe("the knobs port of web", () => {
  it.effect("reads the key with the edge cache ttl and decodes the live value", () =>
    Effect.gen(function* live() {
      const asked: Array<string> = [];

      const level = yield* levelOver((key, options) => {
        asked.push(`${key}:${options.cacheTtl}`);

        return Promise.resolve("Warn");
      });

      assert.strictEqual(level, "Warn");
      assert.isTrue(asked.length > 0 && asked.every((ask) => ask === "LOG_LEVEL:30"));
    }),
  );

  it.effect("answers the tier (b) value and reads nothing when the binding is absent", () =>
    Effect.gen(function* absent() {
      const level = yield* Effect.gen(function* read() {
        return yield* yield* webKnobs(undefined).bind(LogLevelKnob);
      }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))), Effect.orDie);

      assert.strictEqual(level, LogLevelKnob.default);
    }),
  );

  it.effect("answers the tier (b) value when the binding fails", () =>
    Effect.gen(function* failing() {
      const level = yield* levelOver(() => Promise.reject(new Error("kv down")));

      assert.strictEqual(level, LogLevelKnob.default);
    }),
  );
});
