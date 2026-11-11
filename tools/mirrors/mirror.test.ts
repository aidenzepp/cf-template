import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import {
  Mirrors,
  Stamp,
  checkMirrors,
  compareStamp,
  exclusions,
  expectedStamp,
  readPackages,
  versionOf,
} from "./mirror.ts";

/**
 * A lock in the shape `bun.lock` has: JSONC with comments and trailing commas, an aliased entry
 * (the key is not the package name) and a nested key that repeats an anchor.
 */
const lock = `{
  // comments and trailing commas are valid in bun.lock
  "lockfileVersion": 1,
  "packages": {
    "alchemy": ["alchemy@2.0.0-beta.85", "", {}, "sha512-a"],
    "@tanstack/react-start": ["@tanstack/react-start@1.169.5", "", {}, "sha512-b",],
    "aliased": ["real-name@3.1.0", "", {}, "sha512-c"],
    "web/alchemy": ["alchemy@1.0.0", "", {}, "sha512-d"],
  },
}`;

const entry = {
  anchor: "pkg",
  name: "fixture",
  repository: "https://example.invalid/pkg.git",
  sparse: ["/docs/"],
  tag: "v{version}",
  verify: "package.json",
};

/**
 * Creates a directory under this worktree's `work/`, removed when the scope ends.
 */
const scratch = Effect.fn("mirrors.test.scratch")(function* scratch(prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const work = yield* path.fromFileUrl(new URL("../../work", import.meta.url));

  yield* fs.makeDirectory(work, { recursive: true });

  return yield* fs.makeTempDirectoryScoped({ directory: work, prefix });
});

/**
 * Writes the stamp of a checkout of `entry` at `tag`, creating the checkout directory.
 */
const stampCheckout = Effect.fn("mirrors.test.stampCheckout")(function* stampCheckout(
  root: string,
  name: string,
  tag: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, ".mirrors", name);

  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    path.join(dir, ".mirror-stamp.json"),
    yield* Schema.encodeEffect(Schema.fromJsonString(Stamp))({
      exclusions,
      sparse: entry.sparse,
      tag,
    }),
  );
});

it.effect("reads anchors from a JSONC lock, aliases and nested keys included", () =>
  Effect.gen(function* anchors() {
    const packages = yield* readPackages(lock);

    assert.deepStrictEqual(versionOf(packages, "alchemy"), Option.some("2.0.0-beta.85"));
    assert.deepStrictEqual(versionOf(packages, "@tanstack/react-start"), Option.some("1.169.5"));
    assert.deepStrictEqual(versionOf(packages, "aliased"), Option.some("3.1.0"));
    assert.deepStrictEqual(versionOf(packages, "better-auth"), Option.none());
  }),
);

it("compares a stamp with the expected one", () => {
  const expected = expectedStamp(entry, "1.2.3");

  assert.isTrue(Option.isNone(compareStamp(Option.some(expected), expected)));
  assert.deepStrictEqual(
    Option.map(
      compareStamp(Option.some({ ...expected, tag: "v1.0.0" }), expected),
      (s) => s.action,
    ),
    Option.some("clone"),
  );
  assert.deepStrictEqual(
    Option.map(
      compareStamp(Option.some({ ...expected, sparse: ["/other/"] }), expected),
      (s) => s.action,
    ),
    Option.some("sparse"),
  );
  assert.deepStrictEqual(
    Option.map(compareStamp(Option.none(), expected), (s) => s.action),
    Option.some("clone"),
  );
});

it.effect("--check reports a stale stamp, a missing directory and a skipped anchor offline", () =>
  Effect.gen(function* check() {
    const root = yield* scratch("mirrors-check-");
    const packages = yield* readPackages(lock);
    const fresh = { ...entry, anchor: "alchemy", name: "fresh" };
    const old = { ...entry, anchor: "alchemy", name: "old" };
    const gone = { ...entry, anchor: "aliased", name: "gone" };
    const absent = { ...entry, anchor: "better-auth", name: "absent" };

    yield* stampCheckout(root, "fresh", "v2.0.0-beta.85");
    yield* stampCheckout(root, "old", "v1.0.0");

    const reports = yield* checkMirrors(root, [fresh, old, gone, absent], packages);

    assert.deepStrictEqual(
      reports.map((report) => report.line),
      [
        "old: stale (tag v1.0.0, lock wants v2.0.0-beta.85)",
        "gone: stale (missing)",
        "absent: anchor better-auth not in bun.lock, skipped",
      ],
    );
    assert.isTrue(reports.some((report) => report.stale));
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("keeps one entry per name in mirrors.json", () =>
  Effect.gen(function* names() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* path.fromFileUrl(new URL("mirrors.json", import.meta.url));
    const entries = yield* Schema.decodeUnknownEffect(Mirrors)(yield* fs.readFileString(file));
    const found = entries.map((mirror) => mirror.name);

    assert.strictEqual(found.length, 4);
    assert.strictEqual(new Set(found).size, found.length);
  }).pipe(Effect.provide(BunServices.layer)),
);
