import { assert, describe, it } from "@effect/vitest";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Layer, Logger, Option } from "effect";
import type { LogLevel } from "effect";
import { LiveKnobs, fromSource } from "@workspace/config/knob";
import type AuthWorker from "./worker.ts";
import { AuthDeployment, authProps, authTelemetry, makeAtLevel } from "./worker.ts";

/**
 * The services the Worker's layer still needs from its provider. `AuthDeployment` must not be one:
 * only `infra` provides it, and the deployed bundle evaluates the module without it.
 */
type NeededServices = Layer.Services<typeof AuthWorker>;

describe("the auth Worker module", () => {
  it("does not require AuthDeployment", () => {
    const needsNoDeployment: [AuthDeployment] extends [NeededServices] ? false : true = true;

    assert.isTrue(needsNoDeployment);
  });

  it.effect("evaluates its properties with no provider, as the deployed bundle does", () =>
    Effect.gen(function* withoutDeployment() {
      assert.deepStrictEqual(yield* authProps, {});
    }),
  );

  it.effect("takes the properties of the deployment when infra provides it", () =>
    Effect.gen(function* withDeployment() {
      const props = yield* authProps.pipe(
        Effect.provideService(AuthDeployment, { props: { name: "x" }, telemetry: {} }),
      );

      assert.deepStrictEqual(props, { name: "x" });
    }),
  );

  it.effect("takes the tracing options of the deployment, and none in the deployed bundle", () =>
    Effect.gen(function* tracing() {
      const planned = yield* authTelemetry.pipe(
        Effect.provideService(AuthDeployment, { props: {}, telemetry: { headSamplingRate: 1 } }),
      );

      assert.deepStrictEqual(planned, { headSamplingRate: 1 });
      assert.deepStrictEqual(yield* authTelemetry, {});
    }),
  );

  it.effect("runs a request at the live LOG_LEVEL read through the LiveKnobs port", () =>
    Effect.gen(function* liveLevel() {
      const seen: Array<LogLevel.LogLevel> = [];

      const logger = Logger.make(({ logLevel }) => {
        seen.push(logLevel);
      });

      const live = fromSource({ name: "test", read: () => Effect.succeed(Option.some("Warn")) });
      const atLevel = yield* yield* makeAtLevel(Layer.succeed(LiveKnobs, live));

      yield* atLevel(
        Effect.logInfo("handled").pipe(Effect.andThen(Effect.logWarning("slow"))),
      ).pipe(Effect.provide(Logger.layer([logger])));

      assert.deepStrictEqual(seen, ["Warn"]);
    }).pipe(Effect.scoped, Effect.provideService(Cloudflare.WorkerEnvironment, {}), Effect.orDie),
  );
});
