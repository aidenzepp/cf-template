import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import type { PersistedState } from "alchemy/State";
import { D1LocationHintChanged, createdHint, decideLocationHint } from "./d1-hint-guard.ts";

const some = (hint: string) => Option.some(hint);

const none = Option.none<string>();

const existing = (hint: Option.Option<string>) => Option.some(hint);

const decide = (
  stage: string,
  created: Option.Option<Option.Option<string>>,
  desired: Option.Option<string>,
) => decideLocationHint({ created, database: "AppDb", desired, stage });

/**
 * A persisted `created` D1 state holding `props`.
 *
 * @param props - The applied props.
 * @returns The state row.
 */
const persisted = (props: { readonly primaryLocationHint?: string }) =>
  ({
    attr: {},
    bindings: [],
    downstream: [],
    fqn: "AppDb",
    instanceId: "i",
    logicalId: "AppDb",
    namespace: undefined,
    props,
    providerVersion: 1,
    resourceType: "Cloudflare.D1Database",
    status: "created",
  }) satisfies PersistedState;

describe("decideLocationHint", () => {
  it.effect("refuses a changed hint on prod for an existing database", () =>
    Effect.gen(function* changed() {
      const failure = yield* Effect.flip(decide("prod", existing(some("weur")), some("enam")));

      assert.instanceOf(failure, D1LocationHintChanged);
      assert.deepStrictEqual(
        [failure.database, failure.created, failure.desired],
        ["AppDb", "weur", "enam"],
      );
      assert.include(failure.message, "only applies when a database is created");
    }),
  );

  it.effect("refuses set to unset on prod", () =>
    Effect.gen(function* removed() {
      const failure = yield* Effect.flip(decide("prod", existing(some("weur")), none));

      assert.deepStrictEqual([failure.created, failure.desired], ["weur", "unset"]);
    }),
  );

  it.effect("refuses unset to set on prod", () =>
    Effect.gen(function* added() {
      const failure = yield* Effect.flip(decide("prod", existing(none), some("weur")));

      assert.deepStrictEqual([failure.created, failure.desired], ["unset", "weur"]);
    }),
  );

  it.effect("allows equal hints, set or unset, on prod", () =>
    Effect.gen(function* equal() {
      assert.isTrue(
        Exit.isSuccess(yield* Effect.exit(decide("prod", existing(some("weur")), some("weur")))),
      );
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(decide("prod", existing(none), none))));
    }),
  );

  it.effect("allows any hint at the first creation on prod", () =>
    Effect.gen(function* first() {
      assert.isTrue(
        Exit.isSuccess(yield* Effect.exit(decide("prod", Option.none(), some("weur")))),
      );
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(decide("prod", Option.none(), none))));
    }),
  );

  it.effect("allows a change on every non-prod stage", () =>
    Effect.gen(function* nonProd() {
      for (const stage of ["dev", "pr-12", "staging"]) {
        assert.isTrue(
          Exit.isSuccess(yield* Effect.exit(decide(stage, existing(some("weur")), some("enam")))),
        );
      }
    }),
  );
});

describe("createdHint", () => {
  it("reads the applied hint from the persisted props", () => {
    assert.deepStrictEqual(
      createdHint(persisted({ primaryLocationHint: "weur" })),
      Option.some(some("weur")),
    );
    assert.deepStrictEqual(createdHint(persisted({})), Option.some(none));
  });

  it("is none when no state was recorded", () => {
    assert.isTrue(Option.isNone(createdHint(undefined)));
  });
});
