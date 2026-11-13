import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option } from "effect";
import { BunServices } from "@effect/platform-bun";
import {
  AccountCounts,
  PreStepError,
  enforceCap,
  parseStateList,
  planSweep,
  previewCap,
} from "./pre-step.ts";

/**
 * Read a recorded (inferred) listing: its `exit:` line and the output below it.
 */
const fixture = (name: string) =>
  Effect.gen(function* read() {
    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs.readFileString(
      new URL(`fixtures/state-list/${name}.txt`, import.meta.url).pathname,
    );

    const lines = text.split("\n");
    const code = Number(/^exit: (?<code>\d+)$/u.exec(lines[1] ?? "")?.groups?.code);

    return { code, output: lines.slice(2).join("\n") };
  }).pipe(Effect.provide(BunServices.layer));

/**
 * Read and classify a recorded listing.
 */
const read = (name: string) =>
  fixture(name).pipe(Effect.map((f) => parseStateList(f.code, f.output)));

describe("parseStateList", () => {
  it.effect("reads the four states", () =>
    Effect.gen(function* states() {
      assert.strictEqual((yield* read("missing"))._tag, "Missing");
      assert.strictEqual((yield* read("outdated"))._tag, "Outdated");
      assert.strictEqual((yield* read("empty"))._tag, "Empty");
      assert.deepStrictEqual(yield* read("populated"), {
        _tag: "Populated",
        stages: ["prod", "staging-12", "staging-7", "test-ci", "test-i38"],
      });
    }),
  );
});

describe("previewCap", () => {
  it("is the limit when capacity is ample", () => {
    assert.strictEqual(
      previewCap({ limit: 10, liveOtherD1: 0, liveOtherWorkers: 0, plan: "paid" }),
      10,
    );
  });

  it("binds on Workers at 3 per stage", () => {
    assert.strictEqual(
      previewCap({ limit: 10, liveOtherD1: 0, liveOtherWorkers: 480, plan: "paid" }),
      6,
    );
  });

  it("lets a CAP override replace capacity", () => {
    assert.strictEqual(
      previewCap({ capWorkers: 2, limit: 10, liveOtherD1: 0, liveOtherWorkers: 0, plan: "paid" }),
      2,
    );
  });
});

describe("planSweep", () => {
  it("destroys closed previews only and leaves test stages and unknown PRs", () => {
    const state = new Map([
      ["staging-1", "CLOSED"],
      ["staging-2", "OPEN"],
      ["staging-4", "MERGED"],
    ]);

    const result = planSweep(
      ["prod", "staging-1", "staging-2", "staging-3", "staging-4", "test-i38"],
      (stage) => Option.fromNullishOr(state.get(stage)),
    );

    assert.deepStrictEqual(result.destroy, ["staging-1", "staging-4"]);
    assert.deepStrictEqual(result.leftover, ["prod", "staging-2", "staging-3", "test-i38"]);
  });
});

/**
 * Run the cap check with a fake account holding `workers` other Workers.
 */
const cap = (config: Record<string, string>, workers: number, count: number) =>
  enforceCap("example", count, false).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          AccountCounts,
          AccountCounts.of({ read: () => Effect.succeed({ d1: 0, workers }) }),
        ),
        ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
      ),
    ),
  );

describe("enforceCap", () => {
  it.effect("fails when live counts push the total over the limit", () =>
    Effect.gen(function* over() {
      const error = yield* Effect.flip(cap({}, 485, 5));

      assert.instanceOf(error, PreStepError);
      assert.include(error.message, "cap is 5");
    }),
  );

  it.effect("passes under the cap and honors a CAP_WORKERS override", () =>
    Effect.gen(function* under() {
      yield* cap({}, 0, 9);

      const error = yield* Effect.flip(cap({ CAP_WORKERS: "1" }, 0, 1));

      assert.include(error.message, "cap is 1");
    }),
  );
});
