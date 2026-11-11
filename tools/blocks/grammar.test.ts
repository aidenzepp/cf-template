import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { parseAttach } from "./grammar.ts";
import type { AttachForm } from "./grammar.ts";
import { parseMeter } from "./meters.ts";
import { readManifest } from "./manifest.ts";

/**
 * Reads the `.txt` fixture `name` from `tools/blocks/fixtures/`.
 */
const fixture = Effect.fn("blocks.test.fixture")(function* fixture(name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.readFileString(
    yield* path.fromFileUrl(new URL(`fixtures/${name}.txt`, import.meta.url)),
  );
});

/**
 * The names `parseAttach` finds in the passing fixture `name` read as `form`.
 */
const attached = Effect.fn("blocks.test.attached")(function* attached(
  form: AttachForm,
  name: string,
) {
  return (yield* parseAttach(form, name, yield* fixture(name))).map((line) => line.name);
});

/**
 * The error message `parseAttach` fails with for the failing fixture `name` read as `form`.
 */
const rejected = Effect.fn("blocks.test.rejected")(function* rejected(
  form: AttachForm,
  name: string,
) {
  return (yield* Effect.flip(parseAttach(form, name, yield* fixture(name)))).message;
});

it.effect("a multi-line Layer.mergeAll( entry passes", () =>
  Effect.gen(function* mergeAll() {
    assert.deepStrictEqual(yield* attached("mergeAll", "merge-all"), ["KnobsKvLive", "NotesLive"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("a bare yield* X; statement passes, an assigned yield* is not an attach line", () =>
  Effect.gen(function* statement() {
    assert.deepStrictEqual(yield* attached("yield", "yield"), ["Web", "Notes"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("an .add(X) link passes", () =>
  Effect.gen(function* link() {
    assert.deepStrictEqual(yield* attached("add", "add-link"), ["SystemApiGroup", "NotesApiGroup"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("an as const array entry passes", () =>
  Effect.gen(function* arrayEntry() {
    assert.deepStrictEqual(yield* attached("array", "array-entry"), ["logLevelKnob", "notesKnob"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("a collapsed Layer.mergeAll(A, B) of core entries passes as A, B", () =>
  Effect.gen(function* collapsed() {
    assert.deepStrictEqual(yield* attached("mergeAll", "collapsed-merge-all"), [
      "KnobsKvLive",
      "NotesLive",
    ]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect(
  "a collapsed Layer.mergeAll(...) holding a unit name fails with the unit's own-line fix",
  () =>
    Effect.gen(function* collapsed() {
      const text = yield* fixture("collapsed-unit");

      const error = yield* Effect.flip(
        parseAttach("mergeAll", "collapsed-unit", text, ["NotesLive"]),
      );

      assert.strictEqual(
        error.message,
        "collapsed attach line collapsed-unit:4: put NotesLive on its own line between // block:NotesLive start and // block:NotesLive end",
      );
    }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("a yield* call normalizes to its head identifier", () =>
  Effect.gen(function* call() {
    assert.deepStrictEqual(yield* attached("yield", "yield-call"), [
      "knobsNamespace",
      "BudgetGuard",
    ]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("a collapsed line of only its own unit inside its marker region passes", () =>
  Effect.gen(function* region() {
    const text = yield* fixture("collapsed-region");
    const lines = yield* parseAttach("mergeAll", "collapsed-region", text, ["NotesLive"]);

    assert.deepStrictEqual(
      lines.map((line) => line.name),
      ["NotesLive"],
    );
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("a collapsed list mixing a region-marked unit with core entries still fails", () =>
  Effect.gen(function* mixed() {
    const text = yield* fixture("collapsed-mixed-region");

    const error = yield* Effect.flip(
      parseAttach("mergeAll", "collapsed-mixed-region", text, ["NotesLive"]),
    );

    assert.strictEqual(
      error.message,
      "collapsed attach line collapsed-mixed-region:5: put NotesLive on its own line between // block:NotesLive start and // block:NotesLive end",
    );
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("comment text never parses as an attach form", () =>
  Effect.gen(function* comments() {
    assert.deepStrictEqual(yield* attached("mergeAll", "jsdoc-merge-all"), []);
    assert.deepStrictEqual(yield* attached("mergeAll", "commented-merge-all"), ["KnobsKvLive"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("a yield* X; on the line after x = fails as an unknown shape", () =>
  Effect.gen(function* continued() {
    assert.strictEqual(
      yield* rejected("yield", "yield-after-assignment"),
      "unknown attach shape yield-after-assignment:3",
    );
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("a Meter: line of none, a list or UNKNOWN(reason) passes", () =>
  Effect.gen(function* passing() {
    assert.deepStrictEqual(yield* parseMeter("Meter: none\n\nBody"), { kind: "none" });
    assert.deepStrictEqual(yield* parseMeter("Meter: KV, D1, Secrets Store"), {
      kind: "list",
      meters: ["KV", "D1", "Secrets Store"],
    });
    assert.deepStrictEqual(yield* parseMeter("Meter: UNKNOWN (pricing unpublished)"), {
      kind: "unknown",
      reason: "pricing unpublished",
    });
  }),
);

it.effect("any other first line fails as a MeterError", () =>
  Effect.gen(function* failing() {
    const readmes = [
      "",
      "# Title\nMeter: none",
      "meter: none",
      "Meter: ",
      "Meter: Bananas",
      "Meter: KV, Bananas",
      "Meter: none, KV",
      "Meter: KV,D1",
      "Meter: UNKNOWN",
      "Meter: UNKNOWN ()",
    ];

    const tags = yield* Effect.all(
      readmes.map((readme) => Effect.map(Effect.flip(parseMeter(readme)), (error) => error._tag)),
    );

    assert.deepStrictEqual(
      tags,
      readmes.map(() => "MeterError"),
    );
  }),
);

it.effect("the three real blocks.ts files parse without an unknown attach shape", () =>
  Effect.gen(function* real() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const names = yield* Effect.forEach(["api", "auth", "web"], (app) =>
      Effect.gen(function* attachFile() {
        const file = `apps/${app}/src/blocks.ts`;

        const text = yield* fs.readFileString(
          yield* path.fromFileUrl(new URL(`../../${file}`, import.meta.url)),
        );

        return (yield* parseAttach("mergeAll", file, text)).map((line) => line.name);
      }),
    );

    assert.deepStrictEqual(names, [
      [
        "SystemApiHandlers",
        // block:notes start
        "NotesApiHandlersNoDeps",
        // block:notes end
        "SessionMiddlewareLive",
        // block:notes start
        "ExampleFeatureGateLive",
        // block:notes end
        "KnobsKvLive",
        "NoIsolateServices",
        // block:notes start
        "NotesIsolateLive",
        // block:notes end
      ],
      ["KnobsKvLive"],
      ["KnobsKvLive"],
    ]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("the real api blocks.ts collapsed onto single lines still yields its seven names", () =>
  Effect.gen(function* collapsedReal() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const text = yield* fs.readFileString(
      yield* path.fromFileUrl(new URL("../../apps/api/src/blocks.ts", import.meta.url)),
    );

    const collapsed = text.replaceAll(
      /Layer\.mergeAll\(\n(?<entries>[^)]*?),?\n\)/gu,
      (_call, body: string) =>
        `Layer.mergeAll(${body
          .split("\n")
          .map((entry) => entry.trim().replace(/,$/u, ""))
          .filter((entry) => !entry.startsWith("//"))
          .join(", ")})`,
    );

    // block:notes start
    assert.notStrictEqual(collapsed, text);
    // block:notes end
    assert.deepStrictEqual(
      (yield* parseAttach("mergeAll", "collapsed-api-blocks", collapsed)).map((line) => line.name),
      [
        "SystemApiHandlers",
        // block:notes start
        "NotesApiHandlersNoDeps",
        // block:notes end
        "SessionMiddlewareLive",
        // block:notes start
        "ExampleFeatureGateLive",
        // block:notes end
        "KnobsKvLive",
        "NoIsolateServices",
        // block:notes start
        "NotesIsolateLive",
        // block:notes end
      ],
    );
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("the real blocks.json decodes", () =>
  Effect.gen(function* real() {
    const path = yield* Path.Path;

    const manifest = yield* readManifest(
      yield* path.fromFileUrl(new URL("../../blocks.json", import.meta.url)),
    );

    assert.strictEqual(manifest.attachFiles.length, 7);
    assert.deepStrictEqual(
      manifest.slices.map((slice) => [slice.name, slice.keep]),
      [
        // block:notes start
        ["notes", ["apps/api/src/notes/table.ts", "apps/api/src/db/schema.ts"]],
        // block:notes end
      ],
    );
    // block:budget-guard start
    assert.deepStrictEqual(
      manifest.blocks.map((block) => block.name),
      ["budget-guard"],
    );
    // block:budget-guard end
  }).pipe(Effect.provide(BunServices.layer)),
);
