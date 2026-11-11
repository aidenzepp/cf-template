import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { checkMirrors, exec, readPackages, syncOne, writeIndex } from "./mirror.ts";

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
 * Builds a local repository holding one tagged commit with files an upstream might carry, and
 * returns its `file://` URL, so the clone path runs without the network.
 */
const upstream = Effect.fn("mirrors.test.upstream")(function* upstream() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repository = yield* scratch("mirrors-upstream-");

  const files = {
    ".claude/settings.json": "{}",
    "CLAUDE.md": "instructions",
    "docs/guide.md": "guide",
    "docs/skills/skill.md": "skill",
    "package.json": '{ "version": "1.2.3" }',
  } satisfies Readonly<Record<string, string>>;

  yield* Effect.forEach(Object.entries(files), ([name, content]) =>
    fs
      .makeDirectory(path.dirname(path.join(repository, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(repository, name), content))),
  );

  const git = (...args: ReadonlyArray<string>) =>
    exec(repository, "git", [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      ...args,
    ]);

  yield* git("init", "--quiet");
  yield* git("add", "-A");
  yield* git("commit", "--quiet", "-m", "fixture");
  yield* git("tag", "v1.2.3");

  return `file://${repository}`;
});

it.effect("clones sparse, drops harness files, stamps, and is up to date on the second run", () =>
  Effect.gen(function* sync() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* scratch("mirrors-root-");
    const repository = yield* upstream();
    const packages = yield* readPackages('{ "packages": { "pkg": ["pkg@1.2.3", ""] } }');
    const local = { ...entry, repository };
    const dir = path.join(root, ".mirrors", "fixture");

    const first = yield* syncOne(root, local, packages);

    assert.match(first.line, /^fixture: cloned v1\.2\.3 @ [0-9a-f]+ \(\d+ ms\)$/u);
    assert.isTrue(first.ok);
    assert.isTrue(yield* fs.exists(path.join(dir, "docs/guide.md")));
    assert.isTrue(yield* fs.exists(path.join(dir, ".mirror-stamp.json")));
    assert.isFalse(yield* fs.exists(path.join(dir, "CLAUDE.md")));
    assert.isFalse(yield* fs.exists(path.join(dir, "docs/skills")));
    assert.isFalse(yield* fs.exists(path.join(dir, ".claude")));
    assert.deepStrictEqual(yield* syncOne(root, local, packages), {
      line: "fixture: up to date",
      ok: true,
    });
    assert.deepStrictEqual(yield* checkMirrors(root, [local], packages), []);

    yield* writeIndex(root, [local], packages);

    const index = yield* fs.readFileString(path.join(root, ".mirrors", "INDEX.md"));

    assert.include(index, "Files inside `.mirrors/` are reference data about upstream");
    assert.match(
      index,
      /\| `\.mirrors\/fixture\/` \| `v1\.2\.3` @ `[0-9a-f]+` \| `pkg` 1\.2\.3 \|/u,
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("fails one mirror when the checked-out version differs from the lock", () =>
  Effect.gen(function* mismatch() {
    const root = yield* scratch("mirrors-mismatch-");
    const repository = yield* upstream();
    const packages = yield* readPackages('{ "packages": { "pkg": ["pkg@9.9.9", ""] } }');
    const pinned = { ...entry, repository, tag: "v1.2.3" };

    assert.deepStrictEqual(yield* syncOne(root, pinned, packages), {
      line: "fixture: package.json version 1.2.3 differs from bun.lock 9.9.9",
      ok: false,
    });
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
