import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Config, Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ignoreEntries } from "./knip-ignores.ts";
import { Baseline, sumCounts } from "./ratchet.ts";

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
 * Builds a repository in a scratch directory under `work/` that the enclosing scope removes: the
 * base fixture committed, then the case's fixture laid over it, the `variation.drop` files removed,
 * and committed, with `origin/main` set per `origin`. Returns the repository and both commits.
 */
const build = Effect.fn("ratchet.test.build")(function* build(
  fixture: string,
  origin: Origin,
  variation: Variation = {},
) {
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
    yield* git(repo, ["update-ref", "refs/remotes/origin/main", origin === "base" ? base : head]);
  }

  return { base, head, repo };
});

/**
 * The repository each case runs the guard in, as an effect that builds it: its fixture, where
 * `origin/main` points and how it differs from the default repository. Cases that differ only in
 * the guard's environment share one.
 */
const SCENARIOS = {
  baselineInvalid: build("baseline-invalid", "base"),
  countsFall: build("counts-fall", "base"),
  directiveAdded: build("directive-added", "head"),
  disableAdded: build("disable-added", "base"),
  equal: build("equal", "base"),
  firstBaseline: build("first-baseline", "base", { from: "bare" }),
  knipIgnoreAdded: build("knip-ignore-added", "base"),
  knipMoved: build("knip-moved", "base"),
  knipRenamed: build("knip-moved", "base", { drop: ["knip.jsonc"] }),
  noBase: build("no-base", "none"),
  override: build("override", "head"),
  packageKnip: build("package-knip", "base"),
  ruleRises: build("rule-rises", "base"),
};

/**
 * The name of a scenario, and the repository built for each.
 */
type Scenario = keyof typeof SCENARIOS;

type Built = Effect.Success<ReturnType<typeof build>>;

/**
 * Every scenario's repository, built once before the first case so each case measures one guard run
 * and not the git commands that make its repository. The guard only reads a repository, so cases
 * share one. The layer's scope removes the directories after the last case.
 */
class Repositories extends Context.Service<Repositories, Record<Scenario, Built>>()(
  "@workspace/test/RatchetRepositories",
) {
  static readonly layer = Layer.effect(
    Repositories,
    Effect.all(SCENARIOS, { concurrency: 4 }),
  ).pipe(Layer.provide(BunServices.layer));
}

/**
 * What a guard case expects: the exit code, the whole output when it must equal a message once
 * trimmed or be empty, text the output holds, text it lacks and whether it is a single line.
 */
interface Expected {
  readonly code: number;
  readonly excludes?: ReadonlyArray<string>;
  readonly exactly?: string;
  readonly includes?: ReadonlyArray<string>;
  readonly oneLine?: boolean;
  readonly silent?: boolean;
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
 * One guard case: the scenario's repository, the guard's extra environment and what it expects.
 */
interface GuardCase {
  readonly env?: Readonly<Record<string, string>>;
  readonly expected: Expected;
  readonly scenario: Scenario;
  readonly title: string;
}

/**
 * The cases that run the guard once and check its exit code and output.
 */
const GUARD_CASES: ReadonlyArray<GuardCase> = [
  {
    expected: { code: 0, silent: true },
    scenario: "equal",
    title: "1 equal counts are silent and exit 0",
  },
  {
    expected: { code: 1, includes: ["no-debugger baselined violations rose from 2 to 3"] },
    scenario: "ruleRises",
    title: "2 a rule count that rises exits 1 and names the rule",
  },
  {
    expected: { code: 1, includes: ["the ceiling is zero"] },
    scenario: "directiveAdded",
    title: "3 an added effect-diagnostics directive exits 1 against any base",
  },
  {
    expected: { code: 1, includes: ["knip ignore entries rose from 1 to 2"] },
    scenario: "knipIgnoreAdded",
    title: "4 an added knip ignore entry exits 1",
  },
  {
    expected: { code: 0, silent: true },
    scenario: "countsFall",
    title: "5 falling counts are silent and exit 0",
  },
  {
    expected: {
      code: 2,
      exactly: "ratchet: no base commit; set RATCHET_BASE or fetch origin/main",
    },
    scenario: "noBase",
    title: "6 no base commit exits 2 with the message",
  },
  {
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "color.ui",
      GIT_CONFIG_VALUE_0: "always",
    },
    expected: { code: 1, includes: ["the ceiling is zero"] },
    scenario: "directiveAdded",
    title: "8 forced git colour still counts and fails the ceiling",
  },
  {
    expected: { code: 1, includes: [`${DISABLE} lines rose from 0 to 1`] },
    scenario: "disableAdded",
    title: "9 an added counted directive line exits 1",
  },
  {
    expected: {
      code: 1,
      excludes: ["knip"],
      includes: ["no-debugger baselined violations rose from 0 to 1"],
    },
    scenario: "firstBaseline",
    title: "10 a baseline the base lacks is compared with zero",
  },
  {
    expected: {
      code: 1,
      includes: ["knip.json configures knip; keep the knip configuration in knip.jsonc"],
    },
    scenario: "knipMoved",
    title: "11 a second knip configuration file exits 1",
  },
  {
    expected: { code: 1, includes: ["knip.jsonc is gone from the head"] },
    scenario: "knipRenamed",
    title: "12 a renamed knip configuration exits 1",
  },
  {
    expected: { code: 1, includes: ["package.json#knip configures knip"] },
    scenario: "packageKnip",
    title: "13 a knip key in package.json exits 1",
  },
  {
    expected: { code: 2, includes: ["oxlint-suppressions.json is not valid"], oneLine: true },
    scenario: "baselineInvalid",
    title: "14 a non-integer count exits 2 on one line",
  },
  {
    env: { RATCHET_BASE: "nope" },
    expected: { code: 2, includes: ["RATCHET_BASE nope is not a commit"], oneLine: true },
    scenario: "equal",
    title: "15 a RATCHET_BASE that is not a commit exits 2 on one line",
  },
  {
    env: { RATCHET_BASE: "0".repeat(40) },
    expected: { code: 1, includes: ["no-debugger baselined violations rose from 2 to 3"] },
    scenario: "ruleRises",
    title: "16 an all-zero RATCHET_BASE falls back to the merge base",
  },
];

describe("the debt ratchet", () => {
  it.layer(Repositories.layer)((cases) => {
    for (const { env, expected, scenario, title } of GUARD_CASES) {
      cases.effect(title, () =>
        Effect.gen(function* checked() {
          const { repo } = (yield* Repositories)[scenario];
          const { code, output } = yield* guard(repo, env);

          assert.strictEqual(code, expected.code, output);

          if (expected.silent === true) {
            assert.strictEqual(output, "");
          }

          if (expected.exactly !== undefined) {
            assert.strictEqual(output.trim(), expected.exactly);
          }

          for (const text of expected.includes ?? []) {
            assert.include(output, text);
          }

          for (const text of expected.excludes ?? []) {
            assert.notInclude(output, text);
          }

          if (expected.oneLine === true) {
            assert.strictEqual(output.trim().split("\n").length, 1, output);
          }
        }).pipe(Effect.provide(BunServices.layer)),
      );
    }

    cases.effect("7a the merge base alone exits 0", () =>
      Effect.gen(function* merged() {
        const { repo } = (yield* Repositories).override;
        const { code, output } = yield* guard(repo);

        assert.strictEqual(code, 0, output);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    cases.effect("7b RATCHET_BASE overrides the merge base", () =>
      Effect.gen(function* override() {
        const { base, repo } = (yield* Repositories).override;
        const { code, output } = yield* guard(repo, { RATCHET_BASE: base });

        assert.strictEqual(code, 1, output);
        assert.include(output, "no-debugger baselined violations rose from 2 to 3");
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

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
