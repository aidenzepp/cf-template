import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Option, Path, Schema, pipe } from "effect";

/**
 * The commit types the header may carry. Defined once, here.
 */
const types = new Set([
  "feat",
  "fix",
  "docs",
  "refactor",
  "test",
  "chore",
  "build",
  "ci",
  "perf",
  "revert",
]);

/**
 * Scopes admitted in addition to the workspace directory names.
 */
const extraScopes = ["tools", "docs", "deps"];

const header = /^(?<type>[a-z]+)(?:\((?<scope>[^()]+)\))?!?: (?<subject>\S.*)$/u;

const trailer = /^Co-Authored-By:/imu;

const trailerMessage =
  "Remove the `Co-Authored-By:` trailer. AI disclosure goes in the pull request body (see /pr-authoring); this repository does not record it in commits.";

/**
 * `MAJOR.MINOR.PATCH` with optional pre-release and build suffixes, as in semver.org.
 */
const semver =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;

/**
 * Whether the first line is a release version once a `chore(<scope>):` prefix and a
 * `[skip ci]` or `[ci skip]` marker are removed.
 */
const isReleaseVersion = (message: string) =>
  semver.test(
    (message.split("\n")[0] ?? "")
      .replace(/^chore\([^)]*\):\s*/u, "")
      .replace(/\s*\[(?:skip ci|ci skip)\]\s*/u, "")
      .trim(),
  );

/**
 * Messages accepted without the header check, ported from `@commitlint/is-ignored` 21.2.4.
 */
const ignored: readonly ((message: string) => boolean)[] = [
  (message) =>
    /^(?:(?:Merge pull request)|(?:Merge .*? into .*?|(?:Merge branch .*?))(?:\r?\n)*$)/mu.test(
      message,
    ),
  (message) => /^(?:Merge tag .*?)(?:\r?\n)*$/mu.test(message),
  (message) => /^[Rr]evert /u.test(message),
  (message) => /^[Rr]eapply /u.test(message),
  (message) => /^(?:amend|fixup|squash)!/u.test(message),
  isReleaseVersion,
  (message) => /^(?:Merged .*?(?:in|into) |Merged PR .*: )/u.test(message),
  (message) => message.startsWith("Merge remote-tracking branch"),
  (message) => message.startsWith("Automatic merge"),
  (message) => /^Auto-merged .*? into /u.test(message),
];

/**
 * Checks a commit message against the rules. Returns the one-line failure naming the broken
 * rule, or nothing when the message is valid. `scopes` are the workspace directory names.
 */
export const validate = (message: string, scopes: readonly string[]): Option.Option<string> => {
  if (trailer.test(message)) {
    return Option.some(trailerMessage);
  }

  if (ignored.some((matches) => matches(message))) {
    return Option.none();
  }

  const first = message.split("\n").find((line) => !line.startsWith("#")) ?? "";
  const groups = header.exec(first.trimEnd())?.groups;

  if (groups === undefined) {
    return Option.some(`header must be \`type(scope)?: subject\`, got \`${first}\``);
  }

  if (!types.has(groups.type ?? "")) {
    return Option.some(`type \`${groups.type}\` is not one of ${[...types].join(", ")}`);
  }

  const { scope } = groups;
  const allowed = [...scopes, ...extraScopes];

  return scope === undefined || allowed.includes(scope)
    ? Option.none()
    : Option.some(`scope \`${scope}\` is not one of ${allowed.join(", ")}`);
};

const packageSchema = Schema.fromJsonString(
  Schema.Struct({ workspaces: Schema.Array(Schema.String) }),
);

/**
 * Expands the root `package.json` `workspaces` globs into the names of the directories that
 * exist: `apps/*` into each directory under `apps`, a literal such as `infra` into itself.
 */
const workspaceScopes = Effect.fn("commitMsg.workspaceScopes")(function* workspaceScopes() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const manifest = yield* fs
    .readFileString("package.json")
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(packageSchema)));

  const isDirectory = (candidate: string) =>
    fs.stat(candidate).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const expand = Effect.fn("commitMsg.expand")(function* expand(glob: string) {
    if (!glob.endsWith("/*")) {
      return (yield* isDirectory(glob)) ? [path.basename(glob)] : [];
    }

    const parent = glob.slice(0, -2);
    const names = yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed((): string[] => []));

    return yield* pipe(
      names,
      Effect.filter((name: string) => isDirectory(path.join(parent, name))),
    );
  });

  const expanded = yield* pipe(
    manifest.workspaces,
    Effect.forEach((glob) => expand(glob)),
  );

  return expanded.flat();
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const fs = yield* FileSystem.FileSystem;

      const file = yield* Effect.fromNullishOr(process.argv.at(2)).pipe(
        Effect.mapError(() => "usage: bun tools/commit-msg/validate.ts <message file>"),
        Effect.orDie,
      );

      const message = yield* fs.readFileString(file);
      const problem = validate(message, yield* workspaceScopes());

      if (Option.isSome(problem)) {
        yield* Console.error(problem.value);
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
