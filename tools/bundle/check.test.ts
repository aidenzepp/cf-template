import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { Chunks, TARGET_KIB, initialFiles, manifestLeak, report } from "./check.ts";
import graph from "./fixtures/chunk-graph.json" with { type: "json" };

describe("initial JavaScript report", () => {
  it("counts the entry and its static imports once, skips lazy chunks and CSS", () => {
    assert.deepStrictEqual(initialFiles(Schema.decodeSync(Chunks)(graph)), [
      "assets/entry.js",
      "assets/shared.js",
      "assets/heavy.js",
    ]);
  });

  it("prints the size in KiB beside the target", () => {
    assert.deepStrictEqual(report(153_600), [`initial JS: 150.0 / ${TARGET_KIB} KiB gzipped`]);
  });

  it("adds a warning line when over the target and does not otherwise", () => {
    assert.deepStrictEqual(report(300 * 1024 + 1), [
      `initial JS: 300.0 / ${TARGET_KIB} KiB gzipped`,
      `warning: initial JS is over the ${TARGET_KIB} KiB target`,
    ]);
    assert.lengthOf(report(300 * 1024), 1);
  });

  it.effect("warns only when the asset directory holds a Vite manifest", () =>
    Effect.gen(function* manifestLeakWarns() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const clientDir = yield* fs.makeTempDirectoryScoped();

      assert.deepStrictEqual(yield* manifestLeak(clientDir), []);

      yield* fs.makeDirectory(path.join(clientDir, ".vite"));
      yield* fs.writeFileString(path.join(clientDir, ".vite/manifest.json"), "{}");

      assert.deepStrictEqual(yield* manifestLeak(clientDir), [
        "warning: Vite manifest found in the Worker asset directory (served publicly at /.vite/manifest.json)",
      ]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
