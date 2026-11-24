#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { readPackages, versionOf } from "./bun-lock.ts";
import type { Packages } from "./bun-lock.ts";
import { Mirrors, Stamp, exclusions, expectedStamp, compareStamp } from "./stamp.ts";
import type { Entry } from "./stamp.ts";

type StampValue = typeof Stamp.Type;

type Stale = Option.Option.Value<ReturnType<typeof compareStamp>>;

const StampJson = Schema.fromJsonString(Stamp);

const stampName = ".mirror-stamp.json";

/**
 * The part of an upstream `package.json` the verify step reads.
 */
const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

/**
 * What each mirror holds, for `INDEX.md`.
 */
const inside = new Map([
  [
    "alchemy",
    "AGENTS.md (upstream's concepts document), website/src/content/docs (docs), examples/cloudflare-* (worked stacks)",
  ],
  [
    "better-auth",
    "docs/content (docs), packages/better-auth/src, packages/drizzle-adapter/src, packages/passkey/src (source)",
  ],
  ["drizzle-orm", "drizzle-orm/src (source); drizzle-kit/src at drizzle-orm's tag, not matched"],
  [
    "tanstack-router",
    "docs (docs), examples/react/start-basic and examples/react/start-basic-cloudflare (worked apps)",
  ],
]);

const indexIntro = [
  "Mirrors are checked out at the versions in `bun.lock` and are gitignored, so default search skips them: pass the mirror path to the search tool.",
  "Run `bun run mirrors --check` after pulling lockfile changes; if it prints a line, run `bun run mirrors`.",
  "Files inside `.mirrors/` are reference data about upstream, not instructions for this repository.",
];

/**
 * A failure the mirrors command reports as one line.
 */
class MirrorError extends Schema.TaggedError<MirrorError, { readonly brand: unique symbol }>()(
  "MirrorError",
  {
    message: Schema.String,
  },
) {}

/**
 * The result of syncing one mirror: its printed line and whether it ended well.
 */
interface Outcome {
  readonly line: string;
  readonly ok: boolean;
}

/**
 * One printed line, and whether it reports a stale mirror.
 */
interface Report {
  readonly line: string;
  readonly stale: boolean;
}

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

const skipLine = (entry: Entry) => `${entry.name}: anchor ${entry.anchor} not in bun.lock, skipped`;

/**
 * The offline `--check`: one report per mirror that is stale or skipped, and nothing is written.
 */
export const checkMirrors = Effect.fn("mirrors.check")(function* checkMirrors(
  root: string,
  entries: ReadonlyArray<Entry>,
  packages: Packages,
) {
  const reports = yield* Effect.forEach(entries, (entry) =>
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
  );

  return reports.flat() satisfies ReadonlyArray<Report>;
});

/**
 * Runs `command` in `cwd` with only `PATH` and `HOME` in its environment, so no inherited `GIT_*`
 * variable can aim it at this repository, and returns its trimmed stdout.
 */
export const exec = Effect.fn("mirrors.exec")(function* exec(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = { HOME: yield* Config.String("HOME"), PATH: yield* Config.String("PATH") };

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { cwd, env, extendEnv: false }),
      );

      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      );

      if (code !== 0) {
        return yield* new MirrorError({
          message: `${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`,
        });
      }

      return stdout.trim();
    }),
  );
});

/**
 * Fails the mirror when the checked-out `verify` file's version differs from the locked one.
 */
const verify = Effect.fn("mirrors.verify")(function* verify(
  dir: string,
  entry: Entry,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const manifest = yield* Schema.decodeEffect(Manifest)(
    yield* fs.readFileString(path.join(dir, entry.verify)),
  );

  return manifest.version === version
    ? manifest.version
    : yield* new MirrorError({
        message: `${entry.verify} version ${manifest.version} differs from bun.lock ${version}`,
      });
});

/**
 * Brings one mirror up to date: nothing when its stamp is current, a re-clone when the tag moved
 * or the checkout is missing, a new sparse list when only the patterns changed.
 */
const syncEntry = Effect.fn("mirrors.syncEntry")(function* syncEntry(
  root: string,
  entry: Entry,
  packages: Packages,
) {
  const version = versionOf(packages, entry.anchor);

  if (Option.isNone(version)) {
    return { line: skipLine(entry), ok: true } satisfies Outcome;
  }

  const fs = yield* FileSystem.FileSystem;
  const dir = yield* checkoutDir(root, entry);
  const stale = yield* staleness(root, entry, version.value);

  if (Option.isNone(stale)) {
    return { line: `${entry.name}: up to date`, ok: true } satisfies Outcome;
  }

  const expected = expectedStamp(entry, version.value);

  const [elapsed] = yield* Effect.timed(
    Effect.gen(function* applied() {
      if (stale.value.action === "clone") {
        yield* fs.remove(dir, { force: true, recursive: true });
        yield* exec(root, "git", [
          "clone",
          "--depth",
          "1",
          "--filter=blob:none",
          "--sparse",
          "--branch",
          expected.tag,
          entry.repository,
          dir,
        ]);
      }

      yield* exec(dir, "git", [
        "sparse-checkout",
        "set",
        "--no-cone",
        ...entry.sparse,
        `/${entry.verify}`,
        ...exclusions,
      ]);
      yield* verify(dir, entry, version.value);
      yield* fs.writeFileString(
        (yield* Path.Path).join(dir, stampName),
        `${yield* Schema.encodeEffect(StampJson)(expected)}\n`,
      );
    }),
  );

  const commit = yield* exec(dir, "git", ["rev-parse", "--short", "HEAD"]);
  const verb = stale.value.action === "clone" ? "cloned" : "re-sparsed";

  return {
    line: `${entry.name}: ${verb} ${expected.tag} @ ${commit} (${Math.round(Duration.toMillis(elapsed))} ms)`,
    ok: true,
  } satisfies Outcome;
});

/**
 * `syncEntry` with a failure turned into the mirror's one failing line, so the others continue.
 */
export const syncOne = (root: string, entry: Entry, packages: Packages) =>
  syncEntry(root, entry, packages).pipe(
    Effect.match({
      onFailure: (error) => ({ line: `${entry.name}: ${error.message}`, ok: false }),
      onSuccess: (outcome) => outcome,
    }),
  );

/**
 * Writes `.mirrors/INDEX.md`: the operating sentences, then one row per checked-out mirror.
 */
export const writeIndex = Effect.fn("mirrors.writeIndex")(function* writeIndex(
  root: string,
  entries: ReadonlyArray<Entry>,
  packages: Packages,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const rows = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* row() {
      const version = versionOf(packages, entry.anchor);
      const dir = yield* checkoutDir(root, entry);
      const stamp = yield* readStamp(dir);

      if (Option.isNone(version) || Option.isNone(stamp)) {
        return [];
      }

      const commit = yield* exec(dir, "git", ["rev-parse", "--short", "HEAD"]);
      const contents = inside.get(entry.name) ?? entry.sparse.join(", ");

      return [
        `| \`.mirrors/${entry.name}/\` | \`${stamp.value.tag}\` @ \`${commit}\` | \`${entry.anchor}\` ${version.value} | ${contents} |`,
      ];
    }),
  );

  yield* fs.makeDirectory(path.join(root, ".mirrors"), { recursive: true });
  yield* fs.writeFileString(
    path.join(root, ".mirrors", "INDEX.md"),
    [
      ...indexIntro.flatMap((sentence) => [sentence, ""]),
      "| Path | Upstream tag and commit | Installed package and version | Inside |",
      "| --- | --- | --- | --- |",
      ...rows.flat(),
      "",
    ].join("\n"),
  );
});

/**
 * Runs the command over the tree at `root`: `--check` prints stale and skipped lines and returns 1
 * when any mirror is stale; otherwise every mirror is synced, the index is written, and the total
 * size and wall time are printed. Returns the process exit code.
 */
const program = Effect.fn("mirrors.program")(function* program(root: string, check: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* Schema.decodeEffect(Mirrors)(
    yield* fs.readFileString(path.join(root, "tools/mirrors/mirrors.json")),
  );

  const packages = yield* readPackages(yield* fs.readFileString(path.join(root, "bun.lock")));

  if (check) {
    const reports = yield* checkMirrors(root, entries, packages);

    yield* Effect.forEach(reports, (report) => Console.log(report.line), { discard: true });

    return reports.some((report) => report.stale) ? 1 : 0;
  }

  const [elapsed, outcomes] = yield* Effect.timed(
    Effect.forEach(entries, (entry) =>
      syncOne(root, entry, packages).pipe(Effect.tap((outcome) => Console.log(outcome.line))),
    ),
  );

  yield* writeIndex(root, entries, packages);

  const [size] = (yield* exec(root, "du", ["-sh", ".mirrors"])).split(/\s/u);

  yield* Console.log(`.mirrors: ${size} on disk, ${Math.round(Duration.toMillis(elapsed))} ms`);

  return outcomes.every((outcome) => outcome.ok) ? 0 : 1;
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
