import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Chunks, TARGET_KIB, initialFiles, report } from "./check.ts";
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

  it.effect(
    "a build leaves no Vite manifest in the Worker asset directory",
    () =>
      Effect.gen(function* assetDirHasNoManifest() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const web = yield* path.fromFileUrl(new URL("../../apps/web/", import.meta.url));
        const handle = yield* spawner.spawn(ChildProcess.make("vp", ["build"], { cwd: web }));

        yield* Stream.runDrain(handle.all);
        assert.strictEqual(yield* handle.exitCode, 0);
        assert.isFalse(yield* fs.exists(path.join(web, "dist/client/.vite/manifest.json")));
        assert.isTrue(yield* fs.exists(path.join(web, "dist/server/chunk-graph.json")));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    120_000,
  );
});
