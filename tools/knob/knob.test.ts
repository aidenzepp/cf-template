import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { KnobKv } from "./alchemy.ts";
import type { NamespaceRef, StoredKey } from "./alchemy.ts";
import { KnobRefused, KnobStatusFailed, execute, parseRequest, reportStored } from "./knob.ts";
import type { KnobRequest } from "./knob.ts";

/**
 * The title of the namespace of a `test-abc` stage of the stack `demo`.
 */
const TITLE = "demo-test-abc-knobs";

/**
 * The one namespace a lookup of {@link TITLE} finds.
 */
const NAMESPACE = { id: "ns-1", title: TITLE } as const;

/**
 * A fake namespace client: it records every call as one line and answers from `namespaces` and
 * `rows`.
 */
const storeOf = (namespaces: ReadonlyArray<NamespaceRef>, rows: ReadonlyArray<StoredKey> = []) => {
  const calls: Array<string> = [];

  const layer = Layer.succeed(
    KnobKv,
    KnobKv.of({
      findNamespaces: (title) =>
        Effect.sync(() => {
          calls.push(`find ${title}`);

          return namespaces.filter((namespace) => namespace.title === title);
        }),
      put: (namespaceId, key, value) =>
        Effect.sync(() => {
          calls.push(`put ${namespaceId} ${key} ${value}`);
        }),
      remove: (namespaceId, key) =>
        Effect.sync(() => {
          calls.push(`remove ${namespaceId} ${key}`);
        }),
      stored: (namespaceId) =>
        Effect.sync(() => {
          calls.push(`stored ${namespaceId}`);

          return rows;
        }),
    }),
  );

  return { calls, layer };
};

/**
 * Run `request` against `store` in an environment of `env` and the stack name `demo`.
 */
const run = (request: KnobRequest, store: ReturnType<typeof storeOf>, env = {}) =>
  execute(request).pipe(
    Effect.provide(store.layer),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ STACK_NAME: "demo", ...env })),
    ),
  );

/**
 * A `set` of `LOG_LEVEL` on the `test-abc` stage.
 */
const setLogLevel = (value: string) =>
  ({ command: "set", key: "LOG_LEVEL", stage: "test-abc", value }) as const;

describe("parseRequest", () => {
  it.effect("requires --stage and one of the three commands", () =>
    Effect.gen(function* usage() {
      assert.instanceOf(yield* Effect.flip(parseRequest(["status"])), KnobRefused);
      assert.instanceOf(yield* Effect.flip(parseRequest(["--stage", "x", "frob"])), KnobRefused);

      assert.deepStrictEqual(yield* parseRequest(["set", "K", "v", "--stage", "x"]), {
        command: "set",
        key: "K",
        stage: "x",
        value: "v",
      });
    }),
  );
});

describe("knob command", () => {
  it.effect("refuses prod without CI before any client call", () =>
    Effect.gen(function* refused() {
      const store = storeOf([NAMESPACE]);
      const failure = yield* Effect.flip(run({ command: "status", stage: "prod" }, store));

      assert.instanceOf(failure, KnobRefused);
      assert.include(failure.message, "prod is refused");
      assert.deepStrictEqual(store.calls, []);
    }),
  );

  it.effect("fails without writing when zero or several namespaces carry the title", () =>
    Effect.gen(function* lookup() {
      for (const namespaces of [[], [NAMESPACE, NAMESPACE]]) {
        const store = storeOf(namespaces);

        assert.instanceOf(yield* Effect.flip(run(setLogLevel("Debug"), store)), KnobRefused);
        assert.deepStrictEqual(store.calls, [`find ${TITLE}`]);
      }
    }),
  );

  it.effect("rejects an invalid value or a key outside the registry before any write", () =>
    Effect.gen(function* invalid() {
      for (const request of [
        setLogLevel("not-a-level"),
        { command: "set", key: "STALE", stage: "test-abc", value: "x" } as const,
      ]) {
        const store = storeOf([NAMESPACE]);

        assert.instanceOf(yield* Effect.flip(run(request, store)), KnobRefused);
        assert.deepStrictEqual(store.calls, [`find ${TITLE}`]);
      }
    }),
  );

  it.effect("writes a valid value and unsets any key in the namespace it found", () =>
    Effect.gen(function* writes() {
      const store = storeOf([NAMESPACE]);

      yield* run(setLogLevel("Debug"), store);
      yield* run({ command: "unset", key: "STALE", stage: "test-abc" }, store);

      assert.deepStrictEqual(store.calls, [
        `find ${TITLE}`,
        "put ns-1 LOG_LEVEL Debug",
        `find ${TITLE}`,
        "remove ns-1 STALE",
      ]);
    }),
  );

  it.effect("fails status on a rejected or orphaned key and passes a clean namespace", () =>
    Effect.gen(function* status() {
      const bad = storeOf([NAMESPACE], [{ key: "LOG_LEVEL", value: "not-a-level" }]);
      const clean = storeOf([NAMESPACE], [{ key: "LOG_LEVEL", value: "Debug" }]);

      assert.instanceOf(
        yield* Effect.flip(run({ command: "status", stage: "test-abc" }, bad)),
        KnobStatusFailed,
      );
      yield* run({ command: "status", stage: "test-abc" }, clean);
    }),
  );
});

describe("reportStored", () => {
  it.effect("names the key and the reason of each finding", () =>
    Effect.gen(function* report() {
      const lines = yield* reportStored([
        { key: "LOG_LEVEL", value: "not-a-level" },
        { key: "STALE", value: "x" },
        { key: "EXAMPLE_FEATURE_ENABLED", value: "true" },
      ]);

      assert.deepStrictEqual(
        lines.map((entry) => entry.bad),
        [true, true, false],
      );
      assert.include(lines[0]?.line, "LOG_LEVEL REJECTED");
      assert.include(lines[1]?.line, "STALE ORPHAN");
      assert.include(lines[2]?.line, "EXAMPLE_FEATURE_ENABLED ok");
    }),
  );
});
