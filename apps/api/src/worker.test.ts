import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Layer } from "effect";
import type ApiWorker from "./worker.ts";
import { ApiDeployment, apiProps, apiTelemetry } from "./worker.ts";

/**
 * The services the Worker's layer still needs from its provider. `ApiDeployment` must not be one:
 * only `infra` provides it, and the deployed bundle evaluates the module without it.
 */
type NeededServices = Layer.Services<typeof ApiWorker>;

describe("the api Worker module", () => {
  it("does not require ApiDeployment", () => {
    const needsNoDeployment: [ApiDeployment] extends [NeededServices] ? false : true = true;

    assert.isTrue(needsNoDeployment);
  });

  it.effect("evaluates its properties with no provider, as the deployed bundle does", () =>
    Effect.gen(function* withoutDeployment() {
      assert.deepStrictEqual(yield* apiProps, {});
    }),
  );

  it.effect("takes the properties of the deployment when infra provides it", () =>
    Effect.gen(function* withDeployment() {
      const props = yield* apiProps.pipe(
        Effect.provideService(ApiDeployment, { props: { name: "x" }, telemetry: {} }),
      );

      assert.deepStrictEqual(props, { name: "x" });
    }),
  );

  it.effect("takes the tracing options of the deployment, and none in the deployed bundle", () =>
    Effect.gen(function* tracing() {
      const planned = yield* apiTelemetry.pipe(
        Effect.provideService(ApiDeployment, { props: {}, telemetry: { headSamplingRate: 1 } }),
      );

      assert.deepStrictEqual(planned, { headSamplingRate: 1 });
      assert.deepStrictEqual(yield* apiTelemetry, {});
    }),
  );
});
