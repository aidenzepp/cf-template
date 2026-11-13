import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, ConfigProvider, Effect, FileSystem, Layer, Option, Ref } from "effect";
import {
  ALL_CREATE_NOTE,
  D1_REPLACE_NOTE,
  EMPTY_PLAN_NOTE,
  checkFingerprint,
  decide,
  renderSummary,
  rowsOfJson,
  verdictOf,
} from "./plan-prod.ts";

/**
 * Read one inferred plan fixture as text.
 */
const fixture = (name: string) =>
  Effect.gen(function* read() {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(
      new URL(`fixtures/plans/${name}.json`, import.meta.url).pathname,
    );
  }).pipe(Effect.provide(BunServices.layer));

/**
 * The verdict of one fixture.
 */
const verdictOfFixture = (name: string) =>
  fixture(name).pipe(Effect.flatMap(rowsOfJson), Effect.flatMap(verdictOf));

describe("plan-prod classifier", () => {
  it.effect("reads an all-noop plan as not destructive", () =>
    Effect.gen(function* allNoop() {
      const verdict = yield* verdictOfFixture("all-noop");

      assert.isFalse(verdict.destructive);
      assert.isTrue(verdict.rows.every((entry) => entry.class === "noop"));
    }),
  );

  it.effect("blocks a D1 replace with the retain line", () =>
    Effect.gen(function* d1Replace() {
      const verdict = yield* verdictOfFixture("d1-replace");
      const blocking = verdict.rows.filter((entry) => entry.class === "blocking");

      assert.isTrue(verdict.destructive);
      assert.deepStrictEqual(
        blocking.map((entry) => entry.row.fqn),
        ["AppDb"],
      );
      assert.deepStrictEqual(blocking[0]?.note, Option.some(D1_REPLACE_NOTE));
      assert.include(renderSummary(verdict), D1_REPLACE_NOTE);
    }),
  );

  it.effect("blocks a prod plan whose rows are all create", () =>
    Effect.gen(function* allCreate() {
      const verdict = yield* verdictOfFixture("all-create");

      assert.isTrue(verdict.destructive);
      assert.isTrue(verdict.rows.every((entry) => entry.class === "blocking"));
      assert.include(renderSummary(verdict), ALL_CREATE_NOTE);
    }),
  );

  it.effect("blocks a KV namespace delete and keeps a Worker update as info", () =>
    Effect.gen(function* kvDelete() {
      const verdict = yield* verdictOfFixture("kv-delete");
      const classes = Object.fromEntries(verdict.rows.map((entry) => [entry.row.fqn, entry.class]));

      assert.isTrue(verdict.destructive);
      assert.strictEqual(classes.KnobsNamespace, "blocking");
      assert.strictEqual(classes.Api, "info");
    }),
  );

  it.effect("holds a plan with no rows and says why", () =>
    Effect.gen(function* emptyPlan() {
      const verdict = yield* verdictOf(yield* rowsOfJson("[]"));

      assert.isTrue(verdict.destructive);
      assert.include(renderSummary(verdict), EMPTY_PLAN_NOTE);
    }),
  );

  it.effect("fails to decode missing or unparsable plan output", () =>
    Effect.gen(function* missingOutput() {
      const missing = yield* Effect.flip(rowsOfJson(""));
      const garbage = yield* Effect.flip(rowsOfJson("not a plan"));

      assert.strictEqual(missing._tag, "PlanProdError");
      assert.strictEqual(garbage._tag, "PlanProdError");
    }),
  );

  it.effect("blocks an orphaned row persisted under a pre-rename stateful type", () =>
    Effect.gen(function* legacyNames() {
      const verdict = yield* verdictOf(
        ["Cloudflare.KVNamespace", "Cloudflare.R2Bucket", "Cloudflare.Queue"].map(
          (resourceType) => ({
            action: "orphaned" as const,
            bindings: [],
            fqn: resourceType,
            logicalId: resourceType,
            resourceType,
          }),
        ),
      );

      assert.isTrue(verdict.destructive);
      assert.deepStrictEqual(
        verdict.rows.map((entry) => entry.class),
        ["blocking", "blocking", "blocking"],
      );
    }),
  );

  it.effect("reads a replace of an unlisted type and an adoption as notices", () =>
    Effect.gen(function* notices() {
      const verdict = yield* verdictOf([
        {
          action: "replace",
          bindings: [],
          fqn: "Api",
          logicalId: "Api",
          resourceType: "Cloudflare.Worker",
        },
        {
          action: "adopted",
          bindings: [],
          fqn: "Web",
          logicalId: "Web",
          resourceType: "Cloudflare.Website",
        },
      ]);

      assert.isFalse(verdict.destructive);
      assert.deepStrictEqual(
        verdict.rows.map((entry) => entry.class),
        ["notice", "notice"],
      );
    }),
  );

  it.effect("fingerprints the blocking rows the same in any order", () =>
    Effect.gen(function* stable() {
      const rows = yield* rowsOfJson(yield* fixture("all-create"));
      const first = yield* verdictOf(rows);
      const second = yield* verdictOf(Arr.reverse(rows));

      assert.match(first.fingerprint, /^[0-9a-f]{64}$/u);
      assert.strictEqual(first.fingerprint, second.fingerprint);
    }),
  );

  it.effect("refuses a stale fingerprint and names both digests", () =>
    Effect.gen(function* staleDigest() {
      const verdict = yield* verdictOfFixture("kv-delete");
      const held = "0".repeat(64);
      const error = yield* Effect.flip(checkFingerprint(verdict, Option.some(held)));

      assert.strictEqual(error._tag, "PlanProdError");
      assert.include(error.message, held);
      assert.include(error.message, verdict.fingerprint);
    }),
  );
});

/**
 * Decode a fixture and run `decide` on it, as the script does, against a file system that
 * records every write.
 */
const decideRecording = (name: string, expected: Option.Option<string>) =>
  Effect.gen(function* run() {
    const writes = yield* Ref.make<ReadonlyArray<readonly [string, string]>>([]);

    const fsLayer = FileSystem.layerNoop({
      writeFileString: (path, data) =>
        Ref.update(writes, (all): ReadonlyArray<readonly [string, string]> => [
          ...all,
          [path, data],
        ]),
    });

    const config = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ GITHUB_OUTPUT: "out", GITHUB_STEP_SUMMARY: "summary" }),
    );

    const text = yield* fixture(name);

    const result = yield* Effect.exit(
      rowsOfJson(text).pipe(
        Effect.flatMap((rows) => decide(rows, expected)),
        Effect.provide(Layer.mergeAll(fsLayer, config)),
      ),
    );

    return { result, writes: yield* Ref.get(writes) };
  });

describe("plan-prod outputs", () => {
  it.effect("writes destructive and fingerprint together for a decoded plan", () =>
    Effect.gen(function* written() {
      const { writes } = yield* decideRecording("d1-replace", Option.none());
      const output = writes.find(([path]) => path === "out")?.[1] ?? "";

      assert.match(output, /^destructive=true\nfingerprint=[0-9a-f]{64}\n$/u);
      assert.isTrue(writes.some(([path]) => path === "summary"));
    }),
  );

  it.effect("writes neither output when an action does not decode", () =>
    Effect.gen(function* unknownAction() {
      const { result, writes } = yield* decideRecording("unknown-action", Option.none());

      assert.isTrue(result._tag === "Failure");
      assert.deepStrictEqual(writes, []);
    }),
  );

  it.effect("writes neither output when the fingerprint is stale", () =>
    Effect.gen(function* staleRun() {
      const { result, writes } = yield* decideRecording("kv-delete", Option.some("0".repeat(64)));

      assert.isTrue(result._tag === "Failure");
      assert.deepStrictEqual(writes, []);
    }),
  );
});
