import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect";

/**
 * One upstream repository to mirror: the `bun.lock` package whose version picks the tag, and the
 * sparse patterns that bound the checkout. `{version}` in `tag` is replaced by the locked version.
 */
export const Mirror = Schema.Struct({
  anchor: Schema.String,
  name: Schema.String,
  repository: Schema.String,
  sparse: Schema.Array(Schema.String),
  tag: Schema.String,
  verify: Schema.String,
});

type Entry = typeof Mirror.Type;

/**
 * The text of `mirrors.json`.
 */
export const Mirrors = Schema.fromJsonString(Schema.Array(Mirror));

/**
 * What a finished checkout records, so a warm run can tell whether anything changed.
 */
export const Stamp = Schema.Struct({
  exclusions: Schema.Array(Schema.String),
  sparse: Schema.Array(Schema.String),
  tag: Schema.String,
});

type StampValue = typeof Stamp.Type;

const StampJson = Schema.fromJsonString(Stamp);

/**
 * The part of `bun.lock` the anchors come from.
 */
const LockJson = Schema.fromJsonString(
  Schema.Struct({
    packages: Schema.Record(
      Schema.String,
      Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Unknown]),
    ),
  }),
);

/**
 * The `packages` table of `bun.lock`: each key maps to an array whose first element reads
 * `<name>@<version>`.
 */
type Packages = typeof LockJson.Type.packages;

/**
 * The negative sparse patterns: files that instruct a harness are reference data here, not
 * instructions.
 */
export const exclusions = ["!CLAUDE.md", "!**/.agents/", "!**/.claude/", "!**/skills/"];

const stampName = ".mirror-stamp.json";

/**
 * One printed line, and whether it reports a stale mirror.
 */
interface Report {
  readonly line: string;
  readonly stale: boolean;
}

/**
 * What a mirror needs to become current: a fresh clone, or only a new sparse list.
 */
interface Stale {
  readonly action: "clone" | "sparse";
  readonly reason: string;
}

/**
 * Matches a string literal (kept) or a comment (dropped), so only text outside strings changes.
 */
const comments = /(?<kept>"(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;

/**
 * Matches a string literal (kept) or a comma that closes an object or array (dropped).
 */
const trailingCommas = /(?<kept>"(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/gu;

/**
 * Turns JSONC into JSON by dropping comments and trailing commas outside strings. `Bun.JSONC` does
 * this on Bun, but the Vitest suite runs on Node, which has no `Bun` global.
 */
const jsoncToJson = (text: string): string =>
  text.replaceAll(comments, "$<kept>").replaceAll(trailingCommas, "$<kept>");

/**
 * Parses `bun.lock` (JSONC, with trailing commas) into its `packages` table.
 */
export const readPackages = Effect.fn("mirrors.readPackages")(function* readPackages(text: string) {
  return (yield* Schema.decodeUnknownEffect(LockJson)(jsoncToJson(text))).packages;
});

/**
 * The locked version of `anchor`: the text after the last `@` of the package's first element,
 * which reads `<name>@<version>` (the name is read from the element because aliases resolve to
 * another name). Nothing when the anchor is not in the lock.
 */
export const versionOf = (packages: Packages, anchor: string): Option.Option<string> =>
  Option.fromNullishOr(packages[anchor]?.[0]).pipe(
    Option.map((spec) => spec.slice(spec.lastIndexOf("@") + 1)),
  );

/**
 * The stamp a current checkout of `entry` at the locked `version` carries.
 */
export const expectedStamp = (entry: Entry, version: string): StampValue => ({
  exclusions,
  sparse: entry.sparse,
  tag: entry.tag.replace("{version}", version),
});

/**
 * Compares a checkout's stamp with the expected one: a missing stamp or another tag means a fresh
 * clone, other lists mean a new sparse checkout only.
 */
export const compareStamp = (
  actual: Option.Option<StampValue>,
  expected: StampValue,
): Option.Option<Stale> => {
  if (Option.isNone(actual)) {
    return Option.some<Stale>({ action: "clone", reason: "no stamp" });
  }

  if (actual.value.tag !== expected.tag) {
    return Option.some<Stale>({
      action: "clone",
      reason: `tag ${actual.value.tag}, lock wants ${expected.tag}`,
    });
  }

  return JSON.stringify([actual.value.sparse, actual.value.exclusions]) ===
    JSON.stringify([expected.sparse, expected.exclusions])
    ? Option.none()
    : Option.some<Stale>({ action: "sparse", reason: "sparse patterns or exclusions changed" });
};

/**
 * Where a mirror's checkout lives.
 */
const checkoutDir = Effect.fn("mirrors.checkoutDir")(function* checkoutDir(
  root: string,
  entry: Entry,
) {
  return (yield* Path.Path).join(root, ".mirrors", entry.name);
});

/**
 * Reads a checkout's stamp; a missing or unreadable stamp is none.
 */
const readStamp = Effect.fn("mirrors.readStamp")(function* readStamp(dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = (yield* Path.Path).join(dir, stampName);

  if (!(yield* fs.exists(file))) {
    return Option.none<StampValue>();
  }

  return yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(StampJson)), Effect.option);
});

/**
 * Whether the checkout of `entry` is stale against the locked `version`, offline.
 */
const staleness = Effect.fn("mirrors.staleness")(function* staleness(
  root: string,
  entry: Entry,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* checkoutDir(root, entry);

  if (!(yield* fs.exists(dir))) {
    return Option.some<Stale>({ action: "clone", reason: "missing" });
  }

  return compareStamp(yield* readStamp(dir), expectedStamp(entry, version));
});

const skipLine = (entry: Entry): string =>
  `${entry.name}: anchor ${entry.anchor} not in bun.lock, skipped`;

/**
 * The offline `--check`: one report per mirror that is stale or skipped, and nothing is written.
 */
export const checkMirrors = Effect.fn("mirrors.check")(function* checkMirrors(
  root: string,
  entries: ReadonlyArray<Entry>,
  packages: Packages,
) {
  const reports = yield* Effect.all(
    entries.map((entry) =>
      Effect.gen(function* checked() {
        const version = versionOf(packages, entry.anchor);

        if (Option.isNone(version)) {
          return [{ line: skipLine(entry), stale: false }];
        }

        const stale = yield* staleness(root, entry, version.value);

        return Option.isSome(stale)
          ? [{ line: `${entry.name}: stale (${stale.value.reason})`, stale: true }]
          : [];
      }),
    ),
  );

  return reports.flat() satisfies ReadonlyArray<Report>;
});

/**
 * Runs the command over the tree at `root`: `--check` prints stale and skipped lines and returns 1
 * when any mirror is stale. Without `--check` it prints that the sync is not here yet and returns
 * 1; the sparse sync lands in part 2. Returns the process exit code.
 */
export const program = Effect.fn("mirrors.program")(function* program(
  root: string,
  check: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* Schema.decodeUnknownEffect(Mirrors)(
    yield* fs.readFileString(path.join(root, "tools/mirrors/mirrors.json")),
  );

  const packages = yield* readPackages(yield* fs.readFileString(path.join(root, "bun.lock")));

  if (!check) {
    yield* Console.error("sync lands in part 2; run with --check");

    return 1;
  }

  const reports = yield* checkMirrors(root, entries, packages);

  yield* Effect.all(reports.map((report) => Console.log(report.line)));

  return reports.some((report) => report.stale) ? 1 : 0;
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const path = yield* Path.Path;

      const code = yield* program(
        yield* path.fromFileUrl(new URL("../..", import.meta.url)),
        process.argv.includes("--check"),
      );

      yield* Effect.sync(() => {
        process.exitCode = code;
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
