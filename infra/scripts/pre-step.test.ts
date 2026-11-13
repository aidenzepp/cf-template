import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { BunServices } from "@effect/platform-bun";
import { parseStateList, planSweep, previewCap } from "./pre-step.ts";

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
