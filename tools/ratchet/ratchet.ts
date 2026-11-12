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
import { Jsonc } from "effect/encoding";
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
 * The baseline file: per file, per rule, the number of baselined violations.
 */
const Baseline = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, Schema.Struct({ count: Schema.Number })),
);

/**
 * The failure of a git command the ratchet needs: it exited with a code other than the ones the
 * ratchet reads as an answer.
 */
export class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", {
  message: Schema.String,
}) {}

/**
 * The failure of a counted file: it does not parse, or it has not the expected shape.
 */
export class CountedFileInvalid extends Schema.TaggedError<CountedFileInvalid>()(
  "CountedFileInvalid",
  { message: Schema.String },
) {}

/**
 * The three counts of one tree. A counter whose file the tree lacks is `None` and takes no part in
 * a comparison.
 */
export interface Counts {
  readonly directives: Readonly<Record<string, number>>;
  readonly knipIgnores: Option.Option<number>;
  readonly rules: Option.Option<Readonly<Record<string, number>>>;
}

/**
 * What a run decided: the exit code and the lines to print.
 */
export interface Outcome {
  readonly code: 0 | 1 | 2;
  readonly lines: ReadonlyArray<string>;
}

/**
 * Runs `git <args>` in the current directory and returns its exit code and stdout.
 */
const git = Effect.fn("ratchet.git")(function* git(args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make("git", args, { stderr: "ignore" }));

  const [stdout, code] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
    { concurrency: 2 },
  );

  return { code: Number(code), stdout };
}, Effect.scoped);

/**
 * Runs `git <args>` and returns its stdout, failing with {@link GitFailed} on any non-zero exit.
 */
const gitOutput = Effect.fn("ratchet.gitOutput")(function* gitOutput(args: ReadonlyArray<string>) {
  const { code, stdout } = yield* git(args);

  return code === 0
    ? stdout
    : yield* new GitFailed({ message: `git ${args.join(" ")} exited with code ${code}` });
});

/**
 * Resolves the base commit: `RATCHET_BASE` when set, else `git merge-base HEAD origin/main`. `None`
 * when neither names a commit.
 */
const resolveBase = Effect.fn("ratchet.resolveBase")(function* resolveBase() {
  const override = (yield* Config.option(Config.String("RATCHET_BASE"))).pipe(
    Option.filter((value) => value !== ""),
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

  return resolved.code === 0 ? Option.some(resolved.stdout.trim()) : Option.none<string>();
});

/**
 * Sums the per-file counts `git grep -c` prints, one `[<ref>:]<path>:<count>` line per file.
 */
const sumCounts = (stdout: string): number =>
  stdout
    .split("\n")
    .filter((line) => line !== "")
    .reduce((total, line) => total + Number(line.slice(line.lastIndexOf(":") + 1)), 0);

/**
 * The lines of tracked source that contain `pattern` as a literal substring, in the tree at `ref`
 * or in the working tree when `ref` is `None`. Exit code 1 is git's answer for no match.
 */
const directiveLines = Effect.fn("ratchet.directiveLines")(function* directiveLines(
  pattern: string,
  ref: Option.Option<string>,
) {
  const { code, stdout } = yield* git([
    "grep",
    "-F",
    "-c",
    "-e",
    pattern,
    ...Option.match(ref, { onNone: () => [], onSome: (sha) => [sha] }),
    "--",
    ...SCAN_PATHSPEC,
  ]);

  return code === 0 || code === 1
    ? sumCounts(stdout)
    : yield* new GitFailed({ message: `git grep exited with code ${code}` });
});

/**
 * Parses JSONC `text` and decodes it with `schema`, naming `file` when it does not.
 */
const decodeFile = <A, I>(
  file: string,
  text: string,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, CountedFileInvalid> =>
  Effect.fromResult(Jsonc.parse(text)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(
      () =>
        new CountedFileInvalid({
          message: `${file} is not valid JSON with the expected shape; restore it from git or regenerate it`,
        }),
    ),
  );

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
 * Whether a parsed knip value is an array, which an `ignore*` key holds.
 */
const isList = Schema.is(Schema.Array(Schema.Json));

/**
 * The entries of every `ignore*` array in a parsed knip configuration, at any depth.
 */
const ignoreEntries = (value: Schema.Json): number => {
  if (!isNode(value)) {
    return 0;
  }

  let total = 0;

  for (const [key, item] of Object.entries(value)) {
    total += key.startsWith("ignore") && isList(item) ? item.length : ignoreEntries(item);
  }

  return total;
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

  const directives = yield* Effect.all(
    DIRECTIVES.map((pattern) => directiveLines(pattern, ref)),
    { concurrency: 4 },
  );

  return {
    directives: Rec.fromEntries(Arr.zip(DIRECTIVES, directives)),
    knipIgnores: yield* Effect.transposeOption(
      knip.pipe(
        Option.map((text) => decodeFile(KNIP, text, Schema.Json).pipe(Effect.map(ignoreEntries))),
      ),
    ),
    rules: yield* Effect.transposeOption(
      baseline.pipe(
        Option.map((text) => decodeFile(BASELINE, text, Baseline).pipe(Effect.map(ruleTotals))),
      ),
    ),
  } satisfies Counts;
});

/**
 * One line per counter of `head` that rose above `base`. A counter compares only when both trees
 * hold its file; the ceiling-zero directive fails on `head` alone.
 */
export const compare = (head: Counts, base: Counts): ReadonlyArray<string> => {
  const rules = Option.match(Option.all([head.rules, base.rules]), {
    onNone: () => [],
    onSome: ([after, earlier]) =>
      Object.entries(after).flatMap(([rule, total]) => {
        const before = earlier[rule] ?? 0;

        return total > before
          ? [`ratchet: ${rule} baselined violations rose from ${before} to ${total}`]
          : [];
      }),
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

  const knip = Option.match(Option.all([head.knipIgnores, base.knipIgnores]), {
    onNone: () => [],
    onSome: ([after, before]) =>
      after > before ? [`ratchet: knip ignore entries rose from ${before} to ${after}`] : [],
  });

  return [...rules, ...directives, ...knip];
};

/**
 * Counts the repository the process runs in and compares it with the base commit: exit 0 when no
 * count rose, 1 when one did, 2 when no base resolves.
 */
export const ratchet = Effect.fn("ratchet.run")(function* ratchet() {
  const root = (yield* gitOutput(["rev-parse", "--show-toplevel"])).trim();
  const base = yield* resolveBase();

  if (Option.isNone(base)) {
    return { code: 2, lines: [NO_BASE] } satisfies Outcome;
  }

  const lines = compare(yield* count(root, Option.none()), yield* count(root, base));

  return { code: lines.length === 0 ? 0 : 1, lines } satisfies Outcome;
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const { code, lines } = yield* ratchet();

      yield* Effect.all(lines.map((line) => Console.error(line)));
      yield* Effect.sync(() => {
        process.exitCode = code;
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
