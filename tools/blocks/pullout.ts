import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Array as Arr,
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

import { attachFormOf, parseAttach } from "./grammar.ts";
import type { AttachLine } from "./grammar.ts";
import { readManifest, withoutUnit } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import { removeMarked } from "./markers.ts";

/**
 * Raised when the pull-out refuses to start or a step finds a problem the caller must fix.
 */
export class PulloutError extends Schema.TaggedError<
  PulloutError,
  { readonly brand: unique symbol }
>()("PulloutError", {
  message: Schema.String,
}) {}

/**
 * The decoded fields of a `package.json`, in file order.
 */
const PackageJson = Schema.Record(Schema.String, Schema.Json);

/**
 * What the pull-out knows about the unit it removes. `doomed` tells whether a repository-relative
 * file goes with the unit; `tree` is the throwaway worktree the edits happen in.
 */
interface Unit {
  readonly doomed: (file: string) => boolean;
  readonly keep: ReadonlyArray<string>;
  readonly name: string;
  readonly packageName: string | undefined;
  readonly tree: string;
}

/**
 * A tracked `package.json`: its directory and its decoded fields.
 */
interface Pkg {
  readonly dir: string;
  readonly json: typeof PackageJson.Type;
}

/**
 * `package.json` fields holding dependency names.
 */
const dependencySections = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

/**
 * A named import: optional `type`, the braced names and the specifier.
 */
const namedImport =
  /^import\s+(?<type>type\s+)?\{(?<names>[^}]*)\}\s*from\s*"(?<spec>[^"]+)";?[ \t]*\n/gmu;

/**
 * Decodes the contents of a `package.json`.
 */
const decodePackage = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson));

/**
 * Decodes an object of strings, as `exports` and the dependency sections are.
 */
const decodeStrings = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String));

/**
 * The value as an object of strings, or nothing when it is another JSON value.
 */
const stringsOf = (value: Schema.Json): Readonly<Record<string, string>> | undefined =>
  Option.getOrUndefined(decodeStrings(value));

/**
 * Whether a value is a string.
 */
const isString = Schema.is(Schema.String);

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
 * Drops the unit's `package.json` footprint: `exports` entries whose target lies under a deleted
 * path and the unit's own dependency line. Returns the files it rewrote.
 */
const trimPackages = Effect.fn("pullout.trimPackages")(function* trimPackages(
  unit: Unit,
  packages: ReadonlyArray<Pkg>,
) {
  const path = yield* Path.Path;

  const byFile = new Map(packages.map((pkg) => [path.join(pkg.dir, "package.json"), pkg] as const));

  const files = [...byFile.keys()].filter((file) => !unit.doomed(file));

  return yield* rewrite(unit.tree, files, (file, text) =>
    decodePackage(text).pipe(
      Effect.map((json) => {
        const dir = path.dirname(file);

        const next = Object.fromEntries(
          Object.entries(json).map(([key, value]) => {
            const exported = key === "exports" ? stringsOf(value) : undefined;
            const depended = dependencySections.has(key) ? stringsOf(value) : undefined;

            if (exported !== undefined) {
              const live = Object.entries(exported).filter(
                ([, target]) => !unit.doomed(path.join(dir, target)),
              );

              return [key, Object.fromEntries(live)];
            }

            if (depended !== undefined) {
              const live = Object.entries(depended).filter(([name]) => name !== unit.packageName);

              return [key, Object.fromEntries(live)];
            }

            return [key, value];
          }),
        );

        return JSON.stringify(next) === JSON.stringify(json)
          ? text
          : `${JSON.stringify(next, null, 2)}\n`;
      }),
    ),
  );
});

/**
 * Removes the unit's attach lines and their imports from the attach files of `manifest`. A name is
 * the unit's when it is imported from a specifier that resolves to a file that goes with the unit;
 * `targets` maps a workspace specifier to its file. A file that imports nothing of the unit has no
 * attach line of it, so it is not parsed and its other lines are never judged.
 */
const detachAttach = Effect.fn("pullout.detachAttach")(function* detachAttach(
  unit: Unit,
  manifest: typeof Manifest.Type,
  targets: ReadonlyMap<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = [...manifest.slices, ...manifest.blocks].map((entry) => entry.name);

  const present = yield* Effect.filter(
    manifest.attachFiles.filter((file) => !unit.doomed(file)),
    (file) => fs.exists(path.join(unit.tree, file)),
  );

  return yield* rewrite(unit.tree, present, (file, text) => {
    const owns = (spec: string) => {
      const target = spec.startsWith(".") ? path.join(path.dirname(file), spec) : targets.get(spec);

      return target !== undefined && unit.doomed(target);
    };

    return readImports(text).some(({ spec }) => owns(spec))
      ? parseAttach(attachFormOf(file), file, text, names).pipe(
          Effect.map((attach) => detach(text, attach, owns)),
        )
      : Effect.succeed(text);
  });
});

/**
 * The files the leftover scan reads: code and its configuration. Prose is not a reference.
 */
const codeFiles = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs", "*.json"];

/**
 * What the leftover scan never reads: the migrations (they stay in every phase), documentation
 * (`docs/**` and every `*.md`), test fixtures that name the unit on purpose (`fixtures/**`) and the
 * repository's own tooling (`tools/**`), which names a unit as test data, never as a dependency.
 */
const unscanned = [
  ":(exclude,glob)apps/*/migrations/**",
  ":(exclude,glob)docs/**",
  ":(exclude,glob)**/fixtures/**",
  ":(exclude,glob)tools/**",
];

/**
 * The text of a string literal that names `name` as a path segment beside a slash: `"./notes/x"`,
 * `"/api/notes"`, `"@workspace/contract/api/notes"`, and not `"notes"`, `"notes.example.com"` or a
 * plain word.
 */
const pathLike = (name: string): string =>
  String.raw`["'\`][^"'\`]*(/${name}(/[^"'\`]*)?|${name}/[^"'\`]*)["'\`]`;

/**
 * The leftover scan: the code references to the unit that remain. A reference is the unit name as a
 * path segment of a string literal (an import or export specifier, a URL or a file path) in a code
 * file, or a `block:<unit>` marker anywhere. Prose, plain words and the `keep` modules are not
 * references, nor is anything in {@link unscanned}. This reads the issue's "leftover scan names
 * nothing but the kept table module" as references, not as every line that spells the word.
 */
const leftovers = Effect.fn("pullout.leftovers")(function* leftovers(unit: Unit) {
  const skip = [...unscanned, ...unit.keep.map((file) => `:(exclude,glob)${file}`)];

  const named = yield* exec(unit.tree, "git", [
    "grep",
    "-nIE",
    "-e",
    pathLike(unit.name),
    "--",
    ...codeFiles,
    ...skip,
  ]);

  const marked = yield* exec(unit.tree, "git", ["grep", "-nIF", "-e", `block:${unit.name}`]);

  return lines(named.output + marked.output);
});

/**
 * The generated route tree of `apps/web`.
 */
const routeTree = "apps/web/src/route-tree.gen.ts";

/**
 * The directory of the routes the generated route tree lists.
 */
const routesDir = "apps/web/src/routes/";

/**
 * Regenerates the web route tree in `unit.tree` when the unit owned routes, by running the web
 * build the TanStack Start plugin generates it in.
 */
const regenerateRoutes = Effect.fn("pullout.regenerateRoutes")(function* regenerateRoutes(
  unit: Unit,
  tracked: ReadonlyArray<string>,
) {
  const owned = tracked.some((file) => file.startsWith(routesDir) && unit.doomed(file));

  if (owned && tracked.includes(routeTree)) {
    yield* run(unit.tree, "bun", ["run", "--filter", "@workspace/web", "build"]);
  }
});

/**
 * Removes `name` from a copy of `HEAD` in `.worktrees/pullout-<name>` under `root`: its paths,
 * attach lines and imports, dependency line, `exports` entries, marked lines and `blocks.json`
 * entry. It writes `<name>.pullout.patch` there, prints its path and fails when the leftover scan
 * finds a reference. It does not run the gates.
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

  const packages = yield* Effect.all(
    tracked
      .filter((file) => path.basename(file) === "package.json")
      .map((file) =>
        fs.readFileString(path.join(root, file)).pipe(
          Effect.flatMap(decodePackage),
          Effect.map((json) => ({ dir: path.dirname(file), json })),
        ),
      ),
  );

  const targets = new Map(
    packages.flatMap(({ dir, json }) => {
      const label = json.name;
      const exported = json.exports;

      if (!isString(label)) {
        return [];
      }

      const entries = Object.entries(stringsOf(exported) ?? {});

      return [
        [label, dir] as const,
        ...entries.map(
          ([key, target]) => [`${label}${key.slice(1)}`, path.join(dir, target)] as const,
        ),
      ];
    }),
  );

  const owner = packages.find((pkg) => pkg.dir === `packages/${name}`)?.json.name;
  const tree = path.join(root, ".worktrees", `pullout-${name}`);
  const unit: Unit = { doomed, keep, name, packageName: isString(owner) ? owner : undefined, tree };

  const [elapsed, left] = yield* Effect.timed(
    Effect.gen(function* removal() {
      yield* run(root, "git", ["worktree", "add", "--detach", tree, "HEAD"]);

      const attached = yield* detachAttach(unit, manifest, targets);

      for (const chunk of Arr.chunksOf(
        tracked.filter((file) => doomed(file)),
        200,
      )) {
        yield* run(tree, "git", ["rm", "--quiet", "--", ...chunk]);
      }

      const trimmed = yield* trimPackages(unit, packages);

      const marks = lines(
        (yield* exec(tree, "git", ["grep", "-lIF", "-e", `block:${name}`])).output,
      );

      const marked = yield* rewrite(tree, marks, (file, text) => removeMarked(name, file, text));

      yield* fs.writeFileString(
        path.join(tree, "blocks.json"),
        `${JSON.stringify(withoutUnit(manifest, name), null, 2)}\n`,
      );

      yield* run(tree, "bunx", ["vp", "fmt", "blocks.json", ...attached, ...trimmed, ...marked]);
      yield* run(tree, "bun", ["install"]);
      yield* regenerateRoutes(unit, tracked);

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
