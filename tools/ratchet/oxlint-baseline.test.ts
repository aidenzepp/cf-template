import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The timeout of each case, which spawns the linter a few times.
 */
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * The baseline file the linter writes: per file, per rule, a count.
 */
const Baseline = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Struct({ count: Schema.Finite })),
  ),
);

/**
 * The files of the sample, which holds four `debugger` statements: two in `a.ts`, one each in
 * `b.ts` and `c.ts`.
 */
const SAMPLE_FILES: ReadonlyArray<string> = ["a.ts", "b.ts", "c.ts", "oxlintrc.json"];

/**
 * Copies the three-file sample into a scratch directory under `work/`, removed when the scope
 * ends, and returns the directory.
 */
const sample = Effect.fn("oxlint-baseline.test.sample")(function* sample() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));
  const source = path.join(root, "tools", "ratchet", "fixtures", "oxlint");

  yield* fs.makeDirectory(path.join(root, "work"), { recursive: true });

  const dir = yield* fs.makeTempDirectoryScoped({
    directory: path.join(root, "work"),
    prefix: "oxlint-baseline-",
  });

  for (const file of SAMPLE_FILES) {
    yield* fs.copyFile(path.join(source, file), path.join(dir, file));
  }

  return dir;
});

/**
 * Runs the pinned linter, `vp lint`, over the sample in `dir` with the sample's own configuration
 * and the extra `flags`, and returns its exit code and combined output.
 */
const lint = Effect.fn("oxlint-baseline.test.lint")(function* lint(
  dir: string,
  flags: ReadonlyArray<string> = [],
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));

  const handle = yield* spawner.spawn(
    ChildProcess.make(
      path.join(root, "node_modules", ".bin", "vp"),
      ["lint", "-c", "oxlintrc.json", ...flags, "a.ts", "b.ts", "c.ts"],
      {
        cwd: dir,
        env: {
          HOME: yield* Config.String("HOME"),
          NO_COLOR: "1",
          PATH: yield* Config.String("PATH"),
        },
        extendEnv: false,
      },
    ),
  );

  const [output, code] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
    { concurrency: 2 },
  );

  return { code: Number(code), output };
}, Effect.scoped);

/**
 * Reads the baseline in `dir` and returns the sum of its counts.
 */
const baselined = Effect.fn("oxlint-baseline.test.baselined")(function* baselined(dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const baseline = yield* Schema.decodeEffect(Baseline)(
    yield* fs.readFileString(path.join(dir, "oxlint-suppressions.json")),
  );

  return Object.values(baseline)
    .flatMap((rules) => Object.values(rules))
    .reduce((total, { count }) => total + count, 0);
});

/**
 * Writes the baseline for the sample, then removes the `debugger` statement of `c.ts`: its entry
 * is stale.
 */
const staleSample = Effect.fn("oxlint-baseline.test.staleSample")(function* staleSample() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* sample();

  yield* lint(dir, ["--suppress-all"]);
  yield* fs.writeFileString(path.join(dir, "c.ts"), "export {};\n");

  return dir;
});

describe("the oxlint baseline the ratchet relies on", () => {
  it.effect(
    "a violation the baseline does not cover fails",
    () =>
      Effect.scoped(
        Effect.gen(function* fresh() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* sample();

          yield* lint(dir, ["--suppress-all"]);
          yield* fs.writeFileString(path.join(dir, "c.ts"), "debugger;\ndebugger;\n");

          const { code, output } = yield* lint(dir);

          assert.strictEqual(code, 1, output);
          assert.include(output, "new violations not covered by the suppressions file");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "a baseline entry with no violation left fails",
    () =>
      Effect.scoped(
        Effect.gen(function* stale() {
          const { code, output } = yield* lint(yield* staleSample());

          assert.strictEqual(code, 1, output);
          assert.include(output, "suppressions that do not occur anymore");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "pruning lowers the baselined count",
    () =>
      Effect.scoped(
        Effect.gen(function* pruned() {
          const dir = yield* staleSample();

          assert.strictEqual(yield* baselined(dir), 4);

          const prune = yield* lint(dir, ["--prune-suppressions"]);

          assert.strictEqual(prune.code, 0, prune.output);
          assert.strictEqual(yield* baselined(dir), 3);
          assert.strictEqual((yield* lint(dir)).code, 0);
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "--suppress-all writes the baseline file",
    () =>
      Effect.scoped(
        Effect.gen(function* written() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* sample();
          const file = path.join(dir, "oxlint-suppressions.json");

          assert.isFalse(yield* fs.exists(file));
          assert.strictEqual((yield* lint(dir)).code, 1);

          const { code, output } = yield* lint(dir, ["--suppress-all"]);

          assert.strictEqual(code, 0, output);
          assert.isTrue(yield* fs.exists(file));
          assert.strictEqual(yield* baselined(dir), 4);
          assert.strictEqual((yield* lint(dir)).code, 0);
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );
});
