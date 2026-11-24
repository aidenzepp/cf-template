import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import {
  Chunks,
  DevtoolsInBundleError,
  assertNoDevtools,
  devtoolsHits,
  TARGET_KIB,
  initialFiles,
  initialGzipBytes,
  manifestLeak,
  report,
} from "./check.ts";
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

  it.effect("fails with a reason when the graph has no entry chunk", () =>
    Effect.gen(function* entryless() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const graphFile = path.join(dir, "chunk-graph.json");

      yield* fs.writeFileString(
        graphFile,
        JSON.stringify({ "a.js": { file: "assets/a.js", imports: [] } }),
      );

      const error = yield* initialGzipBytes(graphFile, dir).pipe(Effect.flip);

      assert.strictEqual(error.message, "no entry chunk in the chunk graph");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

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

  it("names the files that hold a devtools marker", () => {
    assert.deepStrictEqual(
      devtoolsHits([
        { file: "assets/a.js", text: "const x = 1" },
        { file: "assets/b.js", text: 'import("@tanstack/react-router-devtools")' },
      ]),
      ['assets/b.js: contains "@tanstack/react-router-devtools"'],
    );
  });

  it.effect("fails on a build whose client files import devtools and passes on a clean one", () =>
    Effect.gen(function* devtoolsBuild() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtures = yield* path.fromFileUrl(new URL("fixtures/", import.meta.url));

      yield* assertNoDevtools(path.join(fixtures, "client-clean"));

      const error = yield* assertNoDevtools(path.join(fixtures, "client-devtools")).pipe(
        Effect.flip,
      );

      assert.instanceOf(error, DevtoolsInBundleError);
      assert.deepStrictEqual(error.files, [
        'assets/lazy.js: contains "@tanstack/react-router-devtools"',
      ]);
      assert.isTrue(yield* fs.exists(fixtures));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
