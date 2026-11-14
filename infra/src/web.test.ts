import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Order,
  Path,
  Ref,
  Schema,
} from "effect";
import { ForeignRateLimitRules, RateLimitEntrypoint } from "./rate-limit-owner.ts";
import { WEB_MEMO, WEB_WORKSPACE_PACKAGES, guardedDomain, webRootDir } from "./web.ts";

const zone = { id: "zone-1", name: "example.test" };

/**
 * Run `guardedDomain` for `stage` with `env` as the environment, against a fake entrypoint that
 * holds the foreign rule `dash-1` and counts its reads.
 *
 * @param stage - The stage name.
 * @param env - The environment values.
 * @returns The exit of the program and how many times the fake was read.
 */
const run = (stage: "prod" | `test-${string}`, env: Record<string, string>) =>
  Effect.gen(function* guard() {
    const reads = yield* Ref.make(0);

    const entrypoint = Layer.succeed(RateLimitEntrypoint, {
      read: () =>
        Ref.update(reads, (count) => count + 1).pipe(
          Effect.as({ rules: [{ id: "dash-1", ref: undefined }], zone }),
        ),
    });

    const exit = yield* guardedDomain({ stack: "app", stage }, entrypoint).pipe(
      Effect.exit,
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    );

    return { exit, reads: yield* Ref.get(reads) };
  });

describe("guardedDomain", () => {
  it.effect("refuses a hostname stage whose zone holds a foreign rule, naming the variable", () =>
    Effect.gen(function* refused() {
      const { exit, reads } = yield* run("test-x", {
        STAGES_TEST_CUSTOM_DOMAIN: "app.example.test",
      });

      assert.strictEqual(reads, 1);
      assert.isTrue(exit._tag === "Failure");

      const failure = yield* Effect.flip(Effect.suspend(() => exit));

      assert.instanceOf(failure, ForeignRateLimitRules);
      assert.include(failure.message, "STAGES_TEST_CUSTOM_DOMAIN");
    }),
  );

  it.effect("does not read the entrypoint on the workers.dev default", () =>
    Effect.gen(function* skipped() {
      const { exit, reads } = yield* run("test-x", {});

      assert.strictEqual(reads, 0);
      assert.isTrue(exit._tag === "Success");
    }),
  );
});

describe("webRootDir", () => {
  it.effect("resolves to the same absolute apps/web path from any working directory", () =>
    Effect.gen(function* cwdFree() {
      const before = yield* webRootDir();
      const original = process.cwd();
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          process.chdir("/");
        }),
        () =>
          Effect.gen(function* moved() {
            assert.strictEqual(process.cwd(), "/");
            assert.strictEqual(yield* webRootDir(), before);
          }),
        () =>
          Effect.sync(() => {
            process.chdir(original);
          }),
      );
      assert.isTrue(before.startsWith("/"));
      assert.isTrue(before.endsWith("/apps/web"));
    }).pipe(Effect.provide(Path.layer)),
  );
});

const Manifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const WORKSPACE_PREFIX = "@workspace/";

/**
 * The `@workspace/*` packages a manifest depends on, by directory name under `packages/`.
 *
 * @param file - The `package.json` URL.
 * @returns The names after the `@workspace/` prefix.
 */
const workspaceDependencies = (file: URL) =>
  Effect.gen(function* readDependencies() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const manifest = yield* fs
      .readFileString(yield* path.fromFileUrl(file))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));

    return Object.keys(manifest.dependencies ?? {})
      .filter((name) => name.startsWith(WORKSPACE_PREFIX))
      .map((name) => name.slice(WORKSPACE_PREFIX.length));
  });

/**
 * Every `@workspace/*` package `apps/web` depends on, directly or through another one.
 */
const webWorkspaceClosure = Effect.gen(function* closure() {
  const seen = new Set<string>();

  let pending = yield* workspaceDependencies(
    new URL("../../apps/web/package.json", import.meta.url),
  );

  while (pending.length > 0) {
    const next: Array<string> = [];

    for (const name of pending.filter((candidate) => !seen.has(candidate))) {
      seen.add(name);
      next.push(
        ...(yield* workspaceDependencies(
          new URL(`../../packages/${name}/package.json`, import.meta.url),
        )),
      );
    }

    pending = next;
  }

  return Arr.sort([...seen], Order.String);
});

describe("WEB_WORKSPACE_PACKAGES", () => {
  it.effect("lists every @workspace package apps/web depends on, directly or transitively", () =>
    Effect.gen(function* pinned() {
      assert.deepStrictEqual(
        Arr.sort(WEB_WORKSPACE_PACKAGES, Order.String),
        yield* webWorkspaceClosure,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it("hashes the packages and only DESIGN.md from the repository root", () => {
    assert.deepStrictEqual(WEB_MEMO.workspaces, [
      ...WEB_WORKSPACE_PACKAGES.map((name) => ({ cwd: `../../packages/${name}` })),
      { cwd: "../..", include: ["DESIGN.md"] },
    ]);
  });
});
