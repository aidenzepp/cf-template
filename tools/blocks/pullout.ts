import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Array as Arr, Console, Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { parseAttach } from "./grammar.ts";
import type { AttachForm, AttachLine } from "./grammar.ts";
import { readManifest, withoutUnit } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import { removeMarked } from "./markers.ts";

/**
 * Raised when the pull-out refuses to start or a step finds a problem the caller must fix.
 */
export class PulloutError extends Schema.TaggedError<PulloutError>()("PulloutError", {
  message: Schema.String,
}) {}

/**
 * What the pull-out knows about the unit it removes. `doomed` tells whether a repository-relative
 * file goes with the unit; `tree` is the throwaway worktree the edits happen in.
 */
interface Unit {
  readonly doomed: (file: string) => boolean;
  readonly keep: ReadonlyArray<string>;
  readonly name: string;
  readonly tree: string;
}

/**
 * The form each attach file uses; `blocks.ts` files and any unlisted file use `Layer.mergeAll(`.
 */
const forms = new Map<string, AttachForm>([
  ["infra/alchemy.run.ts", "yield"],
  ["packages/contract/src/api/api.ts", "add"],
  ["tools/knob/registry.ts", "array"],
]);

/**
 * A named import: optional `type`, the braced names and the specifier.
 */
const namedImport =
  /^import\s+(?<type>type\s+)?\{(?<names>[^}]*)\}\s*from\s*"(?<spec>[^"]+)";?[ \t]*\n/gmu;

/**
 * Migrations stay in every phase: they count as applied once on `main`.
 */
const isMigration = (file: string): boolean => /(?:^|\/)migrations\//u.test(file);

/**
 * Whether `pattern` (a file, a directory with an optional trailing `/`, or a `dir/**` glob) covers
 * `file`.
 */
const covers = (pattern: string, file: string): boolean => {
  const base = pattern.replace(/\*\*$/u, "").replace(/\/$/u, "");

  return file === base || file.startsWith(`${base}/`);
};

/**
 * The non-empty lines of command output.
 */
const lines = (output: string): ReadonlyArray<string> =>
  output.split("\n").filter((line) => line !== "");

/**
 * The local name an import part binds: `type A as B` binds `B`.
 */
const localName = (part: string): string =>
  part
    .replace(/^type\s+/u, "")
    .split(/\s+as\s+/u)
    .at(-1) ?? "";

/**
 * The named imports of `text`: where each statement starts and ends, its `type` prefix, its
 * specifier and the trimmed parts between its braces.
 */
const readImports = (text: string) =>
  [...text.matchAll(namedImport)].map((match) => ({
    end: match.index + match[0].length,
    parts: (match.groups?.names ?? "")
      .split(",")
      .flatMap((part) => (part.trim() === "" ? [] : [part.trim()])),
    spec: match.groups?.spec ?? "",
    start: match.index,
    type: match.groups?.type ?? "",
  }));

/**
 * Deletes from `text` the attach lines `attach` that `owns` (judged by the specifier each name is
 * imported from), then drops those names from their imports, and the imports left empty.
 */
const detach = (
  text: string,
  attach: ReadonlyArray<AttachLine>,
  owns: (spec: string) => boolean,
): string => {
  const specOf = new Map(
    readImports(text).flatMap(({ parts, spec }) =>
      parts.map((part) => [localName(part), spec] as const),
    ),
  );

  const gone = new Set(attach.flatMap(({ name }) => (owns(specOf.get(name) ?? "") ? [name] : [])));

  const body = text
    .split("\n")
    .filter((_, index) => !attach.some((line) => gone.has(line.name) && line.line === index + 1))
    .join("\n");

  let out = "";
  let at = 0;

  for (const { end, parts, spec, start, type } of readImports(body)) {
    const kept = parts.filter((part) => !gone.has(localName(part)));

    const rebuilt =
      kept.length === 0 ? "" : `import ${type}{ ${kept.join(", ")} } from "${spec}";\n`;

    out +=
      body.slice(at, start) + (kept.length === parts.length ? body.slice(start, end) : rebuilt);
    at = end;
  }

  return out + body.slice(at);
};

/**
 * Runs `command` in `cwd` and returns its exit code and untrimmed stdout; a non-zero exit is a
 * result.
 */
const exec = Effect.fn("pullout.exec")(function* exec(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* spawn() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { cwd, stderr: "ignore" }),
      );

      const [output, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: 2 },
      );

      return { code, output };
    }),
  );
});

/**
 * Runs `command` in `cwd` and returns its stdout, failing on a non-zero exit.
 */
const run = Effect.fn("pullout.run")(function* run(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const { code, output } = yield* exec(cwd, command, args);

  return code === 0
    ? output
    : yield* new PulloutError({ message: `${command} ${args.join(" ")} failed with exit ${code}` });
});

/**
 * Fails with `message` when `problem` holds.
 */
const refuseIf = (problem: boolean, message: string) =>
  problem ? Effect.fail(new PulloutError({ message })) : Effect.void;

/**
 * Passes each of `files` in `tree` through `edit`, writes the ones it changed and returns them.
 */
const rewrite = Effect.fn("pullout.rewrite")(function* rewrite<E, R>(
  tree: string,
  files: ReadonlyArray<string>,
  edit: (file: string, text: string) => Effect.Effect<string, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const changed = yield* Effect.all(
    files.map((file) =>
      Effect.gen(function* one() {
        const text = yield* fs.readFileString(path.join(tree, file));
        const next = yield* edit(file, text);

        if (next === text) {
          return [];
        }

        yield* fs.writeFileString(path.join(tree, file), next);

        return [file];
      }),
    ),
  );

  return changed.flat();
});

/**
 * Removes the unit's attach lines and their imports from the attach files of `manifest`. A name is
 * the unit's when it is imported from a relative specifier that resolves to a file that goes with
 * the unit. A file that imports nothing of the unit has no attach line of it, so it is not parsed
 * and its other lines are never judged.
 */
const detachAttach = Effect.fn("pullout.detachAttach")(function* detachAttach(
  unit: Unit,
  manifest: typeof Manifest.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = [...manifest.slices, ...manifest.blocks].map((entry) => entry.name);

  const present = yield* Effect.filter(
    manifest.attachFiles.filter((file) => !unit.doomed(file)),
    (file) => fs.exists(path.join(unit.tree, file)),
  );

  return yield* rewrite(unit.tree, present, (file, text) => {
    const owns = (spec: string) =>
      spec.startsWith(".") && unit.doomed(path.join(path.dirname(file), spec));

    return readImports(text).some(({ spec }) => owns(spec))
      ? parseAttach(forms.get(file) ?? "mergeAll", file, text, names).pipe(
          Effect.map((attach) => detach(text, attach, owns)),
        )
      : Effect.succeed(text);
  });
});

/**
 * The leftover scan: every line outside `keep` and the migrations that names the unit as a word or
 * still holds a `block:<unit>` marker.
 */
const leftovers = Effect.fn("pullout.leftovers")(function* leftovers(unit: Unit) {
  const skip = [
    ":(exclude,glob)apps/*/migrations/**",
    ...unit.keep.map((file) => `:(exclude,glob)${file}`),
  ];

  const named = yield* exec(unit.tree, "git", [
    "grep",
    "-nIwF",
    "-e",
    unit.name,
    "--",
    ".",
    ...skip,
  ]);

  const marked = yield* exec(unit.tree, "git", ["grep", "-nIF", "-e", `block:${unit.name}`]);

  return lines(named.output + marked.output);
});

/**
 * Removes `name` from a copy of `HEAD` in `.worktrees/pullout-<name>` under `root`: its paths,
 * attach lines and imports, marked lines and `blocks.json` entry. It writes `<name>.pullout.patch`
 * there, prints its path and fails when the leftover scan finds a reference. It does not run the
 * gates.
 */
export const pullout = Effect.fn("pullout")(function* pullout(root: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* refuseIf(
    (yield* run(root, "git", ["status", "--porcelain"])).trim() !== "",
    "commit or stash first: the pull-out tests HEAD",
  );

  const manifest = yield* readManifest(path.join(root, "blocks.json"));
  const tracked = lines(yield* run(root, "git", ["ls-files"]));
  const slice = manifest.slices.find((candidate) => candidate.name === name);
  const block = manifest.blocks.find((candidate) => candidate.name === name);
  const paths = slice?.paths ?? block?.paths ?? [`packages/${name}`];
  const keep = slice?.keep ?? [];

  const doomed = (file: string) =>
    paths.some((pattern) => covers(pattern, file)) &&
    !keep.some((pattern) => covers(pattern, file)) &&
    !isMigration(file);

  yield* refuseIf(
    !/^[a-z0-9-]+$/u.test(name) || !tracked.some((file) => doomed(file)),
    `unknown unit ${name}: no tracked file belongs to it`,
  );

  const tree = path.join(root, ".worktrees", `pullout-${name}`);
  const unit: Unit = { doomed, keep, name, tree };

  const [elapsed, left] = yield* Effect.timed(
    Effect.gen(function* removal() {
      yield* run(root, "git", ["worktree", "add", "--detach", tree, "HEAD"]);

      const attached = yield* detachAttach(unit, manifest);

      for (const chunk of Arr.chunksOf(
        tracked.filter((file) => doomed(file)),
        200,
      )) {
        yield* run(tree, "git", ["rm", "--quiet", "--", ...chunk]);
      }

      const marks = lines(
        (yield* exec(tree, "git", ["grep", "-lIF", "-e", `block:${name}`])).output,
      );

      const marked = yield* rewrite(tree, marks, (file, text) => removeMarked(name, file, text));

      yield* fs.writeFileString(
        path.join(tree, "blocks.json"),
        `${JSON.stringify(withoutUnit(manifest, name), null, 2)}\n`,
      );

      yield* run(tree, "bunx", ["vp", "fmt", "blocks.json", ...attached, ...marked]);

      const patch = path.join(tree, `${name}.pullout.patch`);
      yield* fs.writeFileString(patch, yield* run(tree, "git", ["diff", "--binary", "HEAD"]));
      yield* Console.log(patch);

      return yield* leftovers(unit);
    }).pipe(
      Effect.onError(() =>
        Effect.ignore(exec(root, "git", ["worktree", "remove", "--force", tree])),
      ),
    ),
  );

  yield* Console.log(
    left.length === 0 ? "leftover scan: clean" : `leftover scan:\n${left.join("\n")}`,
  );
  yield* Console.log(`pullout ${name}: ${Duration.toMillis(elapsed)} ms`);
  yield* refuseIf(left.length > 0, `${left.length} reference(s) to ${name} remain outside keep`);
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const root = (yield* run(".", "git", ["rev-parse", "--show-toplevel"])).trim();
      const name = process.argv.at(2);

      yield* pullout(
        root,
        yield* Effect.fromNullishOr(name).pipe(
          Effect.mapError(() => new PulloutError({ message: "usage: bun run pullout <unit>" })),
        ),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
