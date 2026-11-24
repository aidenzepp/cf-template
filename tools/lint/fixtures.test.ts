import { BunServices } from "@effect/platform-bun";

import { assert, describe, it } from "@effect/vitest";

import { Array as Arr, Context, Effect, FileSystem, Layer, Order, Path, Schema } from "effect";

import { ChildProcess, ChildProcessSpawner } from "effect/process";

import antiSlopPreset from "ultracite/oxlint/anti-slop";

import config from "../../vite.config.ts";

/**
 * The lines of `blank-lines/cases.ts` that `anti-slop/require-readable-spacing` reports. The
 * fixture diff for turning that rule off recorded them; the stylistic rule must keep reporting
 * all of them.
 */
const expectedAntiSlopLines: ReadonlyArray<number> = [
  2, 3, 5, 8, 9, 12, 13, 16, 17, 18, 19, 21, 22, 26, 27, 29, 31, 32, 34, 37, 38, 40, 41, 43, 44, 47,
  49, 50, 53, 54, 56, 57, 60,
];

/**
 * The oxlint JSON report, reduced to the file name of each diagnostic.
 */
const Report = Schema.fromJsonString(
  Schema.Struct({ diagnostics: Schema.Array(Schema.Struct({ filename: Schema.String })) }),
);

/**
 * Resolves the repository root, the oxlint binary and the type-aware engine, both from the
 * installed Vite+ so the fixtures and `vp check` run one engine. Vite+ pins `oxlint` and `tsrs` as
 * its own dependencies, so they resolve only from its package location. Vite+ 1.7.0 runs
 * `tsrs-lint` by setting `OXLINT_TSGOLINT_PATH` to it, and every spawn here sets the same variable
 * to the same file.
 */
const toolchain = Effect.gen(function* resolve() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));

  // In an isolated install the dependencies of Vite+ sit beside its real package directory, not
  // beside the `node_modules/vite-plus` link.
  const dependencies = path.dirname(
    yield* fs.realPath(path.join(root, "node_modules", "vite-plus")),
  );

  const tsrsLint = path.join(dependencies, "tsrs", "bin", "tsrs-lint");

  const oxlint = path.join(dependencies, "oxlint", "bin", "oxlint");

  return { oxlint, root, tsrsLint };
});

/**
 * Lints the given fixture files with the fixture's own `.oxlintrc.json` and returns the number of
 * diagnostics reported per file name.
 */
const lintFixture = Effect.fnUntraced(function* lintFixture(
  dir: string,
  files: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { oxlint, root, tsrsLint } = yield* toolchain;

  const output = yield* spawner.string(
    ChildProcess.make(
      "node",
      [
        oxlint,
        "-f",
        "json",
        "-c",
        path.join(dir, ".oxlintrc.json"),
        ...files.map((file) => path.join(dir, file)),
      ],
      { cwd: root, env: { OXLINT_TSGOLINT_PATH: tsrsLint }, extendEnv: true },
    ),
  );

  const { diagnostics } = yield* Schema.decodeEffect(Report)(output);

  return (file: string) =>
    diagnostics.filter((diagnostic) => path.basename(diagnostic.filename) === file).length;
});

/**
 * The rule settings of the repository's own lint configuration.
 */
type LintRules = NonNullable<NonNullable<typeof config.lint>["rules"]>;

/**
 * The oxlint JSON report, reduced to the line of each diagnostic.
 */
const LineReport = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        labels: Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Finite }) })),
      }),
    ),
  }),
);

/**
 * Lints `blank-lines/cases.ts` with exactly one rule, from a throwaway config under `work/`, and
 * returns the sorted, distinct lines it reports.
 */
const reportedLines = Effect.fnUntraced(function* reportedLines(
  jsPlugins: ReadonlyArray<string | { name: string; specifier: string }>,
  rules: LintRules,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { oxlint, root, tsrsLint } = yield* toolchain;

  yield* fs.makeDirectory(path.join(root, "work"), { recursive: true });

  const dir = yield* fs.makeTempDirectoryScoped({ directory: path.join(root, "work") });
  const configPath = path.join(dir, "oxlintrc.json");

  yield* fs.writeFileString(configPath, JSON.stringify({ jsPlugins, rules }));

  const output = yield* spawner.string(
    ChildProcess.make(
      "node",
      [
        oxlint,
        "-f",
        "json",
        "-c",
        configPath,
        path.join(root, "tools", "lint", "fixtures", "blank-lines", "cases.ts"),
      ],
      { cwd: root, env: { OXLINT_TSGOLINT_PATH: tsrsLint }, extendEnv: true },
    ),
  );

  const { diagnostics } = yield* Schema.decodeEffect(LineReport)(output);

  return Arr.sort(
    [...new Set(diagnostics.flatMap(({ labels }) => labels.map(({ span }) => span.line)))],
    Order.Number,
  );
});

/**
 * One expectation about a fixture file: the diagnostics the fixture's own configuration should
 * report on it, and the number it reported.
 */
interface FixtureCount {
  readonly actual: number;
  readonly expected: number;
  readonly label: string;
}

/**
 * Lints every rule fixture directory, `fire.ts` and `pass.ts` together and an exempt-directory
 * `pass` file alone, and returns what each file should report beside what it reported.
 *
 * @param name - The fixture directory's name under `tools/lint/fixtures`.
 * @returns The expectations about the directory's files.
 */
const lintRuleFixture = Effect.fnUntraced(function* lintRuleFixture(name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { root } = yield* toolchain;
  const dir = path.join(root, "tools", "lint", "fixtures", name);

  if (!(yield* fs.exists(path.join(dir, ".oxlintrc.json")))) {
    return [];
  }

  // A JSX fixture is `fire.tsx` and `pass.tsx`; every other fixture is `.ts`.
  const extension = (yield* fs.exists(path.join(dir, "fire.tsx"))) ? "tsx" : "ts";
  const fire = `fire.${extension}`;
  const pass = `pass.${extension}`;
  const count = yield* lintFixture(dir, [fire, pass]);

  const counts: ReadonlyArray<FixtureCount> = [
    { actual: count(fire), expected: 1, label: `${name}/${fire}` },
    { actual: count(pass), expected: 0, label: `${name}/${pass}` },
  ];

  // An exempt-directory fixture also holds `components/ui/pass.<ext>`, which must stay silent.
  const exempt = path.join("components", "ui", pass);

  if (!(yield* fs.exists(path.join(dir, exempt)))) {
    return counts;
  }

  const exemptCount = yield* lintFixture(dir, [exempt]);

  return [...counts, { actual: exemptCount(pass), expected: 0, label: `${name}/${exempt}` }];
});

/**
 * What linting every rule fixture directory reported, run once before the first case. The linter
 * spawns once per directory, about 6 s in all alone, so the spawns run together in the layer and
 * the case only compares counts.
 */
class RuleFixtures extends Context.Service<RuleFixtures, ReadonlyArray<FixtureCount>>()(
  "@workspace/test/LintRuleFixtures",
) {
  static readonly layer = Layer.effect(
    RuleFixtures,
    Effect.gen(function* lintAll() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* toolchain;
      const names = yield* fs.readDirectory(path.join(root, "tools", "lint", "fixtures"));

      return (yield* Effect.forEach(names, lintRuleFixture, { concurrency: 8 })).flat();
    }),
  ).pipe(Layer.provide(BunServices.layer));
}

describe("lint fixtures", () => {
  it.effect("the stylistic padding rule reports every line require-readable-spacing reports", () =>
    Effect.gen(function* superset() {
      const antiSlop = yield* reportedLines(antiSlopPreset.jsPlugins ?? [], {
        "anti-slop/require-readable-spacing": "error",
      });

      const stylistic = yield* reportedLines(["@stylistic/eslint-plugin"], {
        "@stylistic/padding-line-between-statements":
          config.lint?.rules?.["@stylistic/padding-line-between-statements"],
      });

      assert.deepStrictEqual(antiSlop, expectedAntiSlopLines);
      assert.isTrue(antiSlop.every((line) => stylistic.includes(line)));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("the type-aware engine Vite+ uses exists", () =>
    Effect.gen(function* engine() {
      const fs = yield* FileSystem.FileSystem;
      const { oxlint, tsrsLint } = yield* toolchain;

      assert.isTrue(yield* fs.exists(tsrsLint));
      assert.isTrue(yield* fs.exists(oxlint));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.layer(RuleFixtures.layer)((cases) => {
    cases.effect("each rule fixture fires once on fire.ts and never on pass.ts", () =>
      Effect.gen(function* rules() {
        for (const { actual, expected, label } of yield* RuleFixtures) {
          assert.strictEqual(actual, expected, label);
        }
      }),
    );
  });

  it.effect("a package import that leaves rootDir fails the installed tsc with TS6059", () =>
    Effect.gen(function* escape() {
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { root } = yield* toolchain;

      // `typescript` 7.0.2 installs the native compiler behind `node_modules/.bin/tsc`.
      const output = yield* spawner.string(
        ChildProcess.make(
          path.join(root, "node_modules", ".bin", "tsc"),
          ["-p", "tools/lint/fixtures/package-escape/tsconfig.json"],
          { cwd: root },
        ),
      );

      assert.include(output, "error TS6059");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
