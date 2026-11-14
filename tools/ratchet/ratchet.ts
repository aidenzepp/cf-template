import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Array as Arr,
  Config,
  Console,
  Effect,
  FileSystem,
  Option,
  Path,
  Record as Rec,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The message printed, with exit code 2, when no base commit resolves.
 */
const NO_BASE = "ratchet: no base commit; set RATCHET_BASE or fetch origin/main";

/**
 * The baseline `oxlint --suppress-all` writes and `--fix` prunes, relative to the repository root.
 */
const BASELINE = "oxlint-suppressions.json";

/**
 * The knip configuration whose `ignore*` entries are counted, relative to the repository root.
 */
const KNIP = "knip.jsonc";

/**
 * Joins the parts of a directive's spelling. The scan counts literal substrings, so a source file
 * that wrote a directive out whole would count itself; the spellings below are assembled instead.
 */
const spell = (...parts: ReadonlyArray<string>): string => parts.join("");

/**
 * The suppression directives the scan counts, as literal substrings of tracked source.
 */
const DIRECTIVES: ReadonlyArray<string> = [
  spell("oxlint", "-disable"),
  spell("eslint", "-disable"),
  spell("@ts", "-expect-error"),
  spell("@ts", "-ignore"),
  spell("@ts", "-nocheck"),
  spell("@effect", "-diagnostics"),
];

/**
 * The directive held at a ceiling of zero: any match fails whatever the base holds.
 */
const CEILING_ZERO = spell("@effect", "-diagnostics");

/**
 * The pathspecs the directive scan reads: every tracked file but the ratchet's own fixtures, the
 * baseline file and Markdown, where a directive suppresses nothing and the ban is only described.
 */
const SCAN_PATHSPEC: ReadonlyArray<string> = [
  ".",
  ":(exclude)tools/ratchet/fixtures",
  `:(exclude)${BASELINE}`,
  ":(exclude)*.md",
];

/**
 * The pathspecs of the knip configuration files other than `knip.jsonc`, relative to the root.
 */
const STRAY_KNIP: ReadonlyArray<string> = [
  "knip.json",
  ".knip.json",
  ".knip.jsonc",
  "knip.js",
  "knip.ts",
  "knip.config.*",
];

/**
 * The baseline file: per file, per rule, the number of baselined violations.
 */
export const Baseline = Schema.Record(
  Schema.String,
  Schema.Record(
    Schema.String,
    Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  ),
);

/**
 * The failure of a git command the ratchet needs: it exited with a code other than the ones the
 * ratchet reads as an answer, or printed a count that is not a non-negative integer. The message
 * keeps git's own stderr.
 */
export class GitFailed extends Schema.TaggedError<GitFailed, { readonly brand: unique symbol }>()(
  "GitFailed",
  {
    message: Schema.String,
  },
) {}

/**
 * The failure of `RATCHET_BASE`: it is set but names no commit.
 */
export class BaseNotCommit extends Schema.TaggedError<
  BaseNotCommit,
  { readonly brand: unique symbol }
>()("BaseNotCommit", {
  message: Schema.String,
}) {}

/**
 * The failure of a counted file: it does not parse, or it has not the expected shape.
 */
export class CountedFileInvalid extends Schema.TaggedError<
  CountedFileInvalid,
  { readonly brand: unique symbol }
>()("CountedFileInvalid", { message: Schema.String }) {}

/**
 * The counts of one tree. A missing baseline counts as zero (#16: absent equals zero). Only the
 * knip counter is `None` when the tree lacks its file, and a `None` takes no part in a comparison.
 */
export interface Counts {
  readonly directives: Readonly<Record<string, number>>;
  readonly knipIgnores: Option.Option<number>;
  readonly rules: Readonly<Record<string, number>>;
}

/**
 * What a run decided: the exit code and the lines to print. Code 1 means a count rose; code 2 means
 * the ratchet could not count.
 */
export interface Outcome {
  readonly code: 0 | 1 | 2;
  readonly lines: ReadonlyArray<string>;
}

/**
 * Collapses a failure message to the one line the ratchet prints.
 */
const oneLine = (message: string): string => message.trim().replaceAll("\n", " ");

/**
 * Runs `git <args>` in the current directory, with colour off whatever the configuration says, and
 * returns its exit code, stdout and stderr.
 */
const git = Effect.fn("ratchet.git")(function* git(args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make("git", ["-c", "color.ui=never", ...args]));

  const [stdout, stderr, code] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: 3 },
  );

  return { code: Number(code), stderr, stdout };
}, Effect.scoped);

/**
 * Runs `git <args>` and returns its stdout, failing with {@link GitFailed} on any non-zero exit.
 */
const gitOutput = Effect.fn("ratchet.gitOutput")(function* gitOutput(args: ReadonlyArray<string>) {
  const { code, stderr, stdout } = yield* git(args);

  return code === 0
    ? stdout
    : yield* new GitFailed({
        message: oneLine(`git ${args.join(" ")} exited with code ${code}: ${stderr}`),
      });
});

/**
 * Whether `value` is the all-zero object name a push event names for a new branch.
 */
const isNullSha = (value: string): boolean => /^0+$/u.test(value);

/**
 * Resolves the base commit: `RATCHET_BASE` when set to something other than empty or an all-zero
 * object name, else `git merge-base HEAD origin/main`. `None` when no merge base exists; a set
 * `RATCHET_BASE` that names no commit fails with {@link BaseNotCommit}.
 */
const resolveBase = Effect.fn("ratchet.resolveBase")(function* resolveBase() {
  const override = (yield* Config.option(Config.String("RATCHET_BASE"))).pipe(
    Option.filter((value) => value !== "" && !isNullSha(value)),
  );

  const candidate = Option.isSome(override)
    ? override
    : Option.some((yield* git(["merge-base", "HEAD", "origin/main"])).stdout.trim()).pipe(
        Option.filter((value) => value !== ""),
      );

  if (Option.isNone(candidate)) {
    return Option.none<string>();
  }

  const resolved = yield* git(["rev-parse", "--verify", "--quiet", `${candidate.value}^{commit}`]);

  if (resolved.code === 0) {
    return Option.some(resolved.stdout.trim());
  }

  return Option.isSome(override)
    ? yield* new BaseNotCommit({ message: `RATCHET_BASE ${candidate.value} is not a commit` })
    : Option.none<string>();
});

/**
 * Parses the count after the last colon of one `git grep -c` line, failing with {@link GitFailed}
 * when it is not a non-negative integer.
 */
const parseCount = (line: string): Effect.Effect<number, GitFailed> => {
  const raw = line.slice(line.lastIndexOf(":") + 1);

  return /^\d+$/u.test(raw)
    ? Effect.succeed(Number(raw))
    : Effect.fail(new GitFailed({ message: `git grep -c printed ${JSON.stringify(line)}` }));
};

/**
 * Sums the per-file counts `git grep -c` prints, one `[<ref>:]<path>:<count>` line per file.
 */
export const sumCounts = (stdout: string): Effect.Effect<number, GitFailed> =>
  Effect.forEach(
    stdout.split("\n").filter((line) => line !== ""),
    parseCount,
  ).pipe(Effect.map((counts) => counts.reduce((total, next) => total + next, 0)));

/**
 * The lines of tracked source that contain `pattern` as a literal substring, in the tree at `ref`
 * or in the working tree when `ref` is `None`. Exit code 1 is git's answer for no match.
 */
const directiveLines = Effect.fn("ratchet.directiveLines")(function* directiveLines(
  pattern: string,
  ref: Option.Option<string>,
) {
  const { code, stderr, stdout } = yield* git([
    "grep",
    "--no-color",
    "-F",
    "-c",
    "-e",
    pattern,
    ...Option.match(ref, { onNone: () => [], onSome: (sha) => [sha] }),
    "--",
    ...SCAN_PATHSPEC,
  ]);

  return code === 0 || code === 1
    ? yield* sumCounts(stdout)
    : yield* new GitFailed({ message: oneLine(`git grep exited with code ${code}: ${stderr}`) });
});

/**
 * Parses JSONC `text` and decodes it with `schema`, naming `file` when it does not. `Bun.JSONC`
 * accepts the trailing commas the formatter writes into `knip.jsonc`; `effect/encoding/Jsonc` does
 * not.
 */
const decodeFile = <A, I>(
  file: string,
  text: string,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, CountedFileInvalid> => {
  const invalid = () =>
    new CountedFileInvalid({
      message: `${file} is not valid JSON with the expected shape; restore it from git or regenerate it`,
    });

  return Effect.try({ catch: invalid, try: () => Bun.JSONC.parse(text) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(invalid),
  );
};

/**
 * The baselined violations per rule, summed over files.
 */
const ruleTotals = (baseline: typeof Baseline.Type) => {
  const totals = new Map<string, number>();

  for (const rules of Object.values(baseline)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      totals.set(rule, (totals.get(rule) ?? 0) + count);
    }
  }

  return Rec.fromEntries(totals);
};

/**
 * Whether a parsed knip value is an object, whose keys the walk reads.
 */
const isNode = Schema.is(Schema.Record(Schema.String, Schema.Json));

/**
 * Whether a parsed knip value is an array, which an `ignore*` key may hold.
 */
const isList = Schema.is(Schema.Array(Schema.Json));

/**
 * Whether a parsed knip value is a string, which counts as one entry wherever it sits.
 */
const isText = Schema.is(Schema.String);

/**
 * The entries beneath an `ignore*` key: a string leaf anywhere counts 1, and so does every array
 * item that is not itself an array or object. Booleans outside an array are settings, not entries.
 */
const leaves = (value: Schema.Json, inList: boolean): number => {
  if (isList(value)) {
    return value.reduce((total: number, item) => total + leaves(item, true), 0);
  }

  if (isNode(value)) {
    return Object.values(value).reduce((total: number, item) => total + leaves(item, false), 0);
  }

  return inList || isText(value) ? 1 : 0;
};

/**
 * The entries beneath every `ignore*` key in a parsed knip configuration, at any depth: a string,
 * an array or an object such as `ignoreIssues`.
 */
export const ignoreEntries = (value: Schema.Json): number => {
  if (isList(value)) {
    return value.reduce((total: number, item) => total + ignoreEntries(item), 0);
  }

  if (!isNode(value)) {
    return 0;
  }

  return Object.entries(value).reduce(
    (total: number, [key, item]) =>
      total + (key.startsWith("ignore") ? leaves(item, false) : ignoreEntries(item)),
    0,
  );
};

/**
 * Reads a counted file from the tree at `ref`, or from the working tree when `ref` is `None`.
 * `None` when the tree lacks the file: `git cat-file -e <ref>:<path>` exits non-zero.
 */
const readCounted = Effect.fn("ratchet.readCounted")(function* readCounted(
  root: string,
  file: string,
  ref: Option.Option<string>,
) {
  if (Option.isSome(ref)) {
    return (yield* git(["cat-file", "-e", `${ref.value}:${file}`])).code === 0
      ? Option.some(yield* gitOutput(["show", `${ref.value}:${file}`]))
      : Option.none<string>();
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(root, file);

  return (yield* fs.exists(absolute))
    ? Option.some(yield* fs.readFileString(absolute))
    : Option.none<string>();
});

/**
 * Counts the three counters in the tree at `ref`, or in the working tree when `ref` is `None`.
 */
const count = Effect.fn("ratchet.count")(function* count(root: string, ref: Option.Option<string>) {
  const baseline = yield* readCounted(root, BASELINE, ref);
  const knip = yield* readCounted(root, KNIP, ref);

  const directives = yield* Effect.forEach(DIRECTIVES, (pattern) => directiveLines(pattern, ref), {
    concurrency: 4,
  });

  return {
    directives: Rec.fromEntries(Arr.zip(DIRECTIVES, directives)),
    knipIgnores: yield* Effect.transposeOption(
      knip.pipe(
        Option.map((text) => decodeFile(KNIP, text, Schema.Json).pipe(Effect.map(ignoreEntries))),
      ),
    ),
    rules: yield* Option.match(baseline, {
      onNone: () => Effect.succeed<Readonly<Record<string, number>>>({}),
      onSome: (text) => decodeFile(BASELINE, text, Baseline).pipe(Effect.map(ruleTotals)),
    }),
  } satisfies Counts;
});

/**
 * One line per counter of `head` that rose above `base`. A missing baseline counts as zero on
 * either side; the knip counter compares only when both trees hold `knip.jsonc`, and fails when
 * only the base does; the ceiling-zero directive fails on `head` alone.
 */
export const compare = (head: Counts, base: Counts): ReadonlyArray<string> => {
  const rules = Object.entries(head.rules).flatMap(([rule, total]) => {
    const before = base.rules[rule] ?? 0;

    return total > before
      ? [`ratchet: ${rule} baselined violations rose from ${before} to ${total}`]
      : [];
  });

  const directives = Object.entries(head.directives).flatMap(([pattern, total]) => {
    if (pattern === CEILING_ZERO) {
      return total > 0
        ? [`ratchet: ${total} ${pattern} directive lines; the ceiling is zero, remove them`]
        : [];
    }

    const before = base.directives[pattern] ?? 0;

    return total > before ? [`ratchet: ${pattern} lines rose from ${before} to ${total}`] : [];
  });

  const knip =
    Option.isNone(head.knipIgnores) && Option.isSome(base.knipIgnores)
      ? [`ratchet: ${KNIP} is gone from the head; keep the knip configuration in ${KNIP}`]
      : Option.match(Option.all([head.knipIgnores, base.knipIgnores]), {
          onNone: () => [],
          onSome: ([after, before]) =>
            after > before ? [`ratchet: knip ignore entries rose from ${before} to ${after}`] : [],
        });

  return [...rules, ...directives, ...knip];
};

/**
 * The tracked knip configuration other than `knip.jsonc`, which the knip counter cannot read:
 * `knip.json`, `.knip.json`, `.knip.jsonc`, `knip.js`, `knip.ts`, `knip.config.*` and the `knip`
 * key of `package.json`. One line when any exists.
 */
const strayKnipConfig = Effect.fn("ratchet.strayKnipConfig")(function* strayKnipConfig(
  root: string,
) {
  const tracked = (yield* gitOutput(["ls-files", "--", ...STRAY_KNIP])).split("\n");

  const manifest = yield* readCounted(root, "package.json", Option.none());

  const inManifest = yield* Option.match(manifest, {
    onNone: () => Effect.succeed(false),
    onSome: (text) =>
      decodeFile("package.json", text, Schema.Record(Schema.String, Schema.Json)).pipe(
        Effect.map((parsed) => "knip" in parsed),
      ),
  });

  const names = [
    ...tracked.filter((name) => name !== ""),
    ...(inManifest ? ["package.json#knip"] : []),
  ];

  return names.length === 0
    ? []
    : [`ratchet: ${names.join(", ")} configures knip; keep the knip configuration in ${KNIP}`];
});

/**
 * Counts the repository the process runs in and compares it with the base commit: exit 0 when no
 * count rose, 1 when one did, 2 when no base resolves, the base is not a commit, git fails or a
 * counted file is invalid.
 */
export const ratchet = Effect.fn("ratchet.run")(
  function* ratchet() {
    const root = (yield* gitOutput(["rev-parse", "--show-toplevel"])).trim();
    const base = yield* resolveBase();

    if (Option.isNone(base)) {
      return { code: 2, lines: [NO_BASE] } satisfies Outcome;
    }

    const lines = [
      ...compare(yield* count(root, Option.none()), yield* count(root, base)),
      ...(yield* strayKnipConfig(root)),
    ];

    return { code: lines.length === 0 ? 0 : 1, lines } satisfies Outcome;
  },
  (run) =>
    run.pipe(
      Effect.catchTags({
        BaseNotCommit: (error) =>
          Effect.succeed({ code: 2, lines: [`ratchet: ${error.message}`] } satisfies Outcome),
        CountedFileInvalid: (error) =>
          Effect.succeed({ code: 2, lines: [`ratchet: ${error.message}`] } satisfies Outcome),
        GitFailed: (error) =>
          Effect.succeed({ code: 2, lines: [`ratchet: ${error.message}`] } satisfies Outcome),
      }),
    ),
);

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const { code, lines } = yield* ratchet();

      yield* Effect.forEach(lines, (line) => Console.error(line), { discard: true });
      yield* Effect.sync(() => {
        process.exitCode = code;
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
