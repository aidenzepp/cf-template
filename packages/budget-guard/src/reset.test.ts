import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { GuardKv, GuardResetRefused, parseStage, resetGuard } from "./reset.ts";
import type { NamespaceRef } from "./reset.ts";

/**
 * The title of the latch namespace of a `test-abc` stage of the stack `demo`.
 */
const TITLE = "demo-test-abc-guard";

/**
 * A fake namespace client: it records every call as one line and answers lookups from `namespaces`.
 */
const clientOf = (namespaces: ReadonlyArray<NamespaceRef>) => {
  const calls: Array<string> = [];

  const layer = Layer.succeed(
    GuardKv,
    GuardKv.of({
      findNamespaces: (title) =>
        Effect.sync(() => {
          calls.push(`find ${title}`);

          return namespaces.filter((namespace) => namespace.title === title);
        }),
      remove: (namespaceId, key) =>
        Effect.sync(() => {
          calls.push(`remove ${namespaceId} ${key}`);
        }),
    }),
  );

  return { calls, layer };
};

/**
 * Reset `stage` against `client` in an environment of `env` and the stack name `demo`.
 */
const run = (stage: string, client: ReturnType<typeof clientOf>, env = {}) =>
  resetGuard(stage).pipe(
    Effect.provide(
      client.layer.pipe(
        Layer.provideMerge(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ STACK_NAME: "demo", ...env })),
        ),
      ),
    ),
  );

describe("parseStage", () => {
  it.effect("accepts exactly --stage <stage>", () =>
    Effect.gen(function* usage() {
      assert.strictEqual(yield* parseStage(["--stage", "test-abc"]), "test-abc");

      for (const args of [
        [],
        ["test-abc"],
        ["--stage"],
        ["--stage", "a", "b"],
        ["--stage", "--x"],
      ]) {
        assert.instanceOf(yield* Effect.flip(parseStage(args)), GuardResetRefused);
      }
    }),
  );
});

describe("resetGuard", () => {
  it.effect("refuses prod without CI before any client call", () =>
    Effect.gen(function* refused() {
      const client = clientOf([{ id: "ns-1", title: "demo-prod-guard" }]);
      const error = yield* Effect.flip(run("prod", client));

      assert.instanceOf(error, GuardResetRefused);
      assert.deepStrictEqual(client.calls, []);
    }),
  );

  it.effect("allows prod under CI", () =>
    Effect.gen(function* allowed() {
      const client = clientOf([{ id: "ns-1", title: "demo-prod-guard" }]);

      yield* run("prod", client, { CI: "true" });

      assert.deepStrictEqual(client.calls, ["find demo-prod-guard", "remove ns-1 state"]);
    }),
  );

  it.effect("deletes the state key of the one matching namespace", () =>
    Effect.gen(function* deleted() {
      const client = clientOf([
        { id: "ns-1", title: TITLE },
        { id: "ns-2", title: "demo-test-abc-knobs" },
      ]);

      yield* run("test-abc", client);

      assert.deepStrictEqual(client.calls, [`find ${TITLE}`, "remove ns-1 state"]);
    }),
  );

  it.effect("writes nothing when no namespace matches", () =>
    Effect.gen(function* none() {
      const client = clientOf([{ id: "ns-2", title: "demo-test-abc-knobs" }]);

      assert.instanceOf(yield* Effect.flip(run("test-abc", client)), GuardResetRefused);
      assert.deepStrictEqual(client.calls, [`find ${TITLE}`]);
    }),
  );

  it.effect("writes nothing when several namespaces match", () =>
    Effect.gen(function* several() {
      const client = clientOf([
        { id: "ns-1", title: TITLE },
        { id: "ns-3", title: TITLE },
      ]);

      assert.instanceOf(yield* Effect.flip(run("test-abc", client)), GuardResetRefused);
      assert.deepStrictEqual(client.calls, [`find ${TITLE}`]);
    }),
  );
});
