import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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
 * Builds a repository in a scratch directory under `work/`: the base fixture committed, then the
 * case's fixture laid over it and committed, with `origin/main` set per `origin`. Hands the
 * repository and both commits to `assertions`; the scope that owns the directory closes after them.
 */
const inRepository = <A, E, R>(
  fixture: string,
  origin: Origin,
  assertions: (built: { base: string; head: string; repo: string }) => Effect.Effect<A, E, R>,
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
      yield* overlay(repo, "base");
      yield* git(repo, ["add", "--all"]);
      yield* git(repo, ["commit", "--quiet", "--message", "base"]);

      const base = yield* git(repo, ["rev-parse", "HEAD"]);

      yield* overlay(repo, fixture);
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
});
