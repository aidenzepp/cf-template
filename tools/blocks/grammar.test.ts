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

it.effect("a collapsed Layer.mergeAll(A, B) fails as an unknown shape", () =>
  Effect.gen(function* collapsed() {
    assert.strictEqual(
      yield* rejected("mergeAll", "collapsed-merge-all"),
      "unknown attach shape collapsed-merge-all:4",
    );
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

it.effect("the real blocks.json decodes", () =>
  Effect.gen(function* real() {
    const path = yield* Path.Path;

    const manifest = yield* readManifest(
      yield* path.fromFileUrl(new URL("../../blocks.json", import.meta.url)),
    );

    assert.strictEqual(manifest.attachFiles.length, 6);
    assert.deepStrictEqual(
      manifest.slices.map((slice) => [slice.name, slice.keep]),
      [["notes", ["apps/api/src/notes/table.ts"]]],
    );
    assert.deepStrictEqual(manifest.blocks, []);
  }).pipe(Effect.provide(BunServices.layer)),
);
