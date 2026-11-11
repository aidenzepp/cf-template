import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Layer } from "effect";
import type AuthWorker from "./worker.ts";
import { AuthDeployment, authProps } from "./worker.ts";

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
        Effect.provideService(AuthDeployment, { props: { name: "x" } }),
      );

      assert.deepStrictEqual(props, { name: "x" });
    }),
  );
});
