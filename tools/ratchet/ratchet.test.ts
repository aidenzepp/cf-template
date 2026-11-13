import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Baseline, ignoreEntries, sumCounts } from "./ratchet.ts";

/**
 * The timeout of each case, which spawns git and `bun` several times.
 */
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * The environment of every spawn: only `PATH` and `HOME`, plus a git configuration that reads no
 * global or system file, so no inherited `GIT_*` variable can aim a command at another repository.
 */
const isolated = Effect.fnUntraced(function* isolated() {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: yield* Config.String("HOME"),
    PATH: yield* Config.String("PATH"),
  };
});

/**
 * Runs `command` in `cwd` under the isolated environment plus `extra` and returns its exit code and
 * combined output.
 */
const spawn = Effect.fn("ratchet.test.spawn")(function* spawn(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  extra: Readonly<Record<string, string>> = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      cwd,
      env: { ...(yield* isolated()), ...extra },
      extendEnv: false,
    }),
  );

  const [output, code] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
    { concurrency: 2 },
  );

  return { code: Number(code), output };
}, Effect.scoped);

/**
 * Runs git in `cwd` with a fixed author and no signing, and returns its trimmed output.
 */
const git = Effect.fn("ratchet.test.git")(function* git(cwd: string, args: ReadonlyArray<string>) {
  const { code, output } = yield* spawn(cwd, "git", [
    "-c",
    "user.name=ratchet",
    "-c",
    "user.email=ratchet@example.com",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);

  assert.strictEqual(code, 0, output);

  return output.trim();
});

/**
 * Copies the files directly inside the fixture directory `name` into `repo`, over what is there.
 */
const overlay = Effect.fn("ratchet.test.overlay")(function* overlay(repo: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("fixtures", import.meta.url));

  for (const file of yield* fs.readDirectory(path.join(root, name))) {
    yield* fs.copyFile(path.join(root, name, file), path.join(repo, file));
  }
});

/**
 * Where `origin/main` points while the guard runs: at the base commit, at the head commit, or
 * nowhere.
 */
type Origin = "base" | "head" | "none";

/**
 * Runs the guard in `repo` and returns its exit code and combined output.
 */
const guard = Effect.fn("ratchet.test.guard")(function* guard(
  repo: string,
  extra: Readonly<Record<string, string>> = {},
) {
  const path = yield* Path.Path;
  const script = yield* path.fromFileUrl(new URL("ratchet.ts", import.meta.url));

  return yield* spawn(repo, "bun", [script], extra);
});

/**
 * How a case differs from the default repository: the fixture the base commit holds (`base`, or
 * `bare`, which has no baseline and no knip file) and the files the head commit removes.
 */
interface Variation {
  readonly drop?: ReadonlyArray<string>;
  readonly from?: "bare" | "base";
}

/**
 * Builds a repository in a scratch directory under `work/`: the base fixture committed, then the
 * case's fixture laid over it, the `variation.drop` files removed, and committed, with
 * `origin/main` set per `origin`. Hands the repository and both commits to `assertions`; the scope
 * that owns the directory closes after them.
 */
const inRepository = <A, E, R>(
  fixture: string,
  origin: Origin,
  assertions: (built: { base: string; head: string; repo: string }) => Effect.Effect<A, E, R>,
  variation: Variation = {},
) =>
  Effect.scoped(
    Effect.gen(function* scoped() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));

      yield* fs.makeDirectory(path.join(root, "work"), { recursive: true });

      const repo = yield* fs.makeTempDirectoryScoped({
        directory: path.join(root, "work"),
        prefix: "ratchet-",
      });

      yield* git(repo, ["init", "--quiet", "--initial-branch=main"]);
      yield* overlay(repo, variation.from ?? "base");
      yield* git(repo, ["add", "--all"]);
      yield* git(repo, ["commit", "--quiet", "--message", "base"]);

      const base = yield* git(repo, ["rev-parse", "HEAD"]);

      yield* overlay(repo, fixture);

      for (const file of variation.drop ?? []) {
        yield* fs.remove(path.join(repo, file));
      }

      yield* git(repo, ["add", "--all"]);
      yield* git(repo, ["commit", "--quiet", "--allow-empty", "--message", "head"]);

      const head = yield* git(repo, ["rev-parse", "HEAD"]);

      if (origin !== "none") {
        yield* git(repo, [
          "update-ref",
          "refs/remotes/origin/main",
          origin === "base" ? base : head,
        ]);
      }

      return yield* assertions({ base, head, repo });
    }),
  );

/**
 * What a guard case expects: the exit code, text the output holds, text it lacks and whether it is
 * a single line.
 */
interface Expected {
  readonly code: number;
  readonly excludes?: ReadonlyArray<string>;
  readonly includes?: ReadonlyArray<string>;
  readonly oneLine?: boolean;
}

/**
 * The Oxlint disable directive, assembled so the guard does not count this file's own text.
 */
const DISABLE = ["oxlint", "-disable"].join("");

/**
 * A baseline file with one rule counted `count` times.
 */
const counted = (count: number) => ({ "a.ts": { rule: { count } } });

/**
 * Registers one case: builds `fixture` per `variation`, runs the guard with `env` and checks
 * `expected`.
 */
const guardCase = (
  title: string,
  fixture: string,
  origin: Origin,
  expected: Expected,
  options: { readonly env?: Readonly<Record<string, string>>; readonly variation?: Variation } = {},
): void => {
  it.effect(
    title,
    () =>
      inRepository(
        fixture,
        origin,
        ({ repo }) =>
          Effect.gen(function* checked() {
            const { code, output } = yield* guard(repo, options.env);

            assert.strictEqual(code, expected.code, output);

            for (const text of expected.includes ?? []) {
              assert.include(output, text);
            }

            for (const text of expected.excludes ?? []) {
              assert.notInclude(output, text);
            }

            if (expected.oneLine === true) {
              assert.strictEqual(output.trim().split("\n").length, 1, output);
            }
          }),
        options.variation,
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );
};

describe("the debt ratchet", () => {
  it.effect(
    "1 equal counts are silent and exit 0",
    () =>
      inRepository("equal", "base", ({ repo }) =>
        Effect.gen(function* equal() {
          const { code, output } = yield* guard(repo);

          assert.strictEqual(code, 0, output);
          assert.strictEqual(output, "");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "2 a rule count that rises exits 1 and names the rule",
    () =>
      inRepository("rule-rises", "base", ({ repo }) =>
        Effect.gen(function* rises() {
          const { code, output } = yield* guard(repo);

          assert.strictEqual(code, 1, output);
          assert.include(output, "no-debugger baselined violations rose from 2 to 3");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "3 an added effect-diagnostics directive exits 1 against any base",
    () =>
      inRepository("directive-added", "head", ({ repo }) =>
        Effect.gen(function* added() {
          const { code, output } = yield* guard(repo);

          assert.strictEqual(code, 1, output);
          assert.include(output, "the ceiling is zero");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "4 an added knip ignore entry exits 1",
    () =>
      inRepository("knip-ignore-added", "base", ({ repo }) =>
        Effect.gen(function* ignored() {
          const { code, output } = yield* guard(repo);

          assert.strictEqual(code, 1, output);
          assert.include(output, "knip ignore entries rose from 1 to 2");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "5 falling counts are silent and exit 0",
    () =>
      inRepository("counts-fall", "base", ({ repo }) =>
        Effect.gen(function* falls() {
          const { code, output } = yield* guard(repo);

          assert.strictEqual(code, 0, output);
          assert.strictEqual(output, "");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "6 no base commit exits 2 with the message",
    () =>
      inRepository("no-base", "none", ({ repo }) =>
        Effect.gen(function* noBase() {
          const { code, output } = yield* guard(repo);

          assert.strictEqual(code, 2, output);
          assert.strictEqual(
            output.trim(),
            "ratchet: no base commit; set RATCHET_BASE or fetch origin/main",
          );
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "7 RATCHET_BASE overrides the merge base",
    () =>
      inRepository("override", "head", ({ base, repo }) =>
        Effect.gen(function* override() {
          const merged = yield* guard(repo);

          assert.strictEqual(merged.code, 0, merged.output);

          const overridden = yield* guard(repo, { RATCHET_BASE: base });

          assert.strictEqual(overridden.code, 1, overridden.output);
          assert.include(overridden.output, "no-debugger baselined violations rose from 2 to 3");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  guardCase(
    "8 forced git colour still counts and fails the ceiling",
    "directive-added",
    "head",
    { code: 1, includes: ["the ceiling is zero"] },
    {
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "color.ui",
        GIT_CONFIG_VALUE_0: "always",
      },
    },
  );

  guardCase("9 an added counted directive line exits 1", "disable-added", "base", {
    code: 1,
    includes: [`${DISABLE} lines rose from 0 to 1`],
  });

  guardCase(
    "10 a baseline the base lacks is compared with zero",
    "first-baseline",
    "base",
    {
      code: 1,
      excludes: ["knip"],
      includes: ["no-debugger baselined violations rose from 0 to 1"],
    },
    { variation: { from: "bare" } },
  );

  guardCase("11 a second knip configuration file exits 1", "knip-moved", "base", {
    code: 1,
    includes: ["knip.json configures knip; keep the knip configuration in knip.jsonc"],
  });

  guardCase(
    "12 a renamed knip configuration exits 1",
    "knip-moved",
    "base",
    { code: 1, includes: ["knip.jsonc is gone from the head"] },
    { variation: { drop: ["knip.jsonc"] } },
  );

  guardCase("13 a knip key in package.json exits 1", "package-knip", "base", {
    code: 1,
    includes: ["package.json#knip configures knip"],
  });

  guardCase("14 a non-integer count exits 2 on one line", "baseline-invalid", "base", {
    code: 2,
    includes: ["oxlint-suppressions.json is not valid"],
    oneLine: true,
  });

  guardCase(
    "15 a RATCHET_BASE that is not a commit exits 2 on one line",
    "equal",
    "base",
    { code: 2, includes: ["RATCHET_BASE nope is not a commit"], oneLine: true },
    { env: { RATCHET_BASE: "nope" } },
  );

  guardCase(
    "16 an all-zero RATCHET_BASE falls back to the merge base",
    "rule-rises",
    "base",
    { code: 1, includes: ["no-debugger baselined violations rose from 2 to 3"] },
    { env: { RATCHET_BASE: "0".repeat(40) } },
  );

  it.effect("17 a count that is not an integer fails the sum", () =>
    Effect.gen(function* sums() {
      assert.strictEqual(yield* sumCounts("a.ts:1\nb.ts:2\n"), 3);

      const colored = yield* Effect.flip(sumCounts("\u001B[35ma.ts\u001B[m\u001B[36m:\u001B[m1\n"));

      assert.strictEqual(colored._tag, "GitFailed");
    }),
  );

  it("18 every ignore form counts, at any depth", () => {
    assert.strictEqual(ignoreEntries({ ignore: "src/a.ts" }), 1);
    assert.strictEqual(ignoreEntries({ ignore: ["a", "b"], ignoreDependencies: ["c"] }), 3);
    assert.strictEqual(ignoreEntries({ ignoreIssues: { "a.ts": ["exports", "types"] } }), 2);
    assert.strictEqual(ignoreEntries({ workspaces: { ".": { ignoreBinaries: ["x"] } } }), 1);
    assert.strictEqual(ignoreEntries({ entry: ["a"], ignoreExportsUsedInFile: true }), 0);
  });

  it.effect("19 a baseline count must be a non-negative integer", () =>
    Effect.gen(function* decodes() {
      const decode = Schema.decodeUnknownEffect(Baseline);

      assert.deepStrictEqual(yield* decode(counted(2)), counted(2));

      for (const bad of [-1, 0.5]) {
        assert.strictEqual((yield* Effect.flip(decode(counted(bad))))._tag, "SchemaError");
      }
    }),
  );
});
