import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SyntaxKind } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";

import { attachFormOf, parseAttach, unreadableMessage } from "./grammar.ts";
import { decodeManifest } from "./manifest.ts";
import { markedLines } from "./markers.ts";
import { parseMeter } from "./meters.ts";

/**
 * Raised by `bun run footprint` when a core file references a unit outside an attach line; the
 * message names every `file:line`.
 */
export class FootprintError extends Schema.TaggedError<
  FootprintError,
  { readonly brand: unique symbol }
>()("FootprintError", {
  message: Schema.String,
}) {}

/**
 * A removable unit and the path patterns it owns: a trailing `/` or `/**` matches a directory, any
 * other pattern one file. A `keep` module stays when the unit is removed, so referencing it is not
 * part of the footprint.
 */
export interface Unit {
  readonly keep?: ReadonlyArray<string>;
  readonly name: string;
  readonly paths: ReadonlyArray<string>;
}

/**
 * An import specifier found in a source file, with its 1-based line.
 */
export interface ImportRef {
  readonly line: number;
  readonly specifier: string;
}

/**
 * One token of a source file: its kind, its offset, and its value (the unescaped text of a string).
 */
interface Token {
  readonly kind: SyntaxKind;
  readonly start: number;
  readonly value: string;
}

/**
 * The token kinds after which a `/` divides rather than opens a regular expression.
 */
const operandEnds = new Set<SyntaxKind>([
  SyntaxKind.Identifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
]);

/**
 * Tokenizes `text` with TypeScript's own scanner. The scanner does not know its context, so this
 * rescans a `/` that opens a regular expression and the `}` that resumes a template literal. JSX
 * text is not understood: an apostrophe in it costs the rest of that line.
 */
const tokenize = (text: string): ReadonlyArray<Token> => {
  const scanner = createScanner(true, undefined, text);
  const tokens: Array<Token> = [];
  const templates: Array<number> = [];
  let depth = 0;
  let kind = scanner.scan();

  while (kind !== SyntaxKind.EndOfFile) {
    const divides = operandEnds.has(tokens.at(-1)?.kind ?? SyntaxKind.Unknown);

    if ((kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) && !divides) {
      kind = scanner.reScanSlashToken();
    } else if (kind === SyntaxKind.OpenBraceToken) {
      depth += 1;
    } else if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === depth) {
      kind = scanner.reScanTemplateToken(false);

      if (kind === SyntaxKind.TemplateTail) {
        templates.pop();
      }
    } else if (kind === SyntaxKind.CloseBraceToken) {
      depth -= 1;
    } else if (kind === SyntaxKind.TemplateHead) {
      templates.push(depth);
    }

    tokens.push({ kind, start: scanner.getTokenStart(), value: scanner.getTokenValue() });
    kind = scanner.scan();
  }

  return tokens;
};

/**
 * The statement keywords and `;` that end the clause an import or export started.
 */
const clauseEnds = new Set<SyntaxKind>([
  SyntaxKind.SemicolonToken,
  SyntaxKind.ImportKeyword,
  SyntaxKind.ExportKeyword,
]);

/**
 * The module specifier of the clause that starts at `index`: the string right after `import`, after
 * `from`, or inside `(`. The clause ends at a `;` or the next statement.
 */
const clauseSource = (tokens: ReadonlyArray<Token>, index: number): Token | undefined => {
  for (let at = index + 1; at < tokens.length; at += 1) {
    const token = tokens[at];
    const before = tokens[at - 1]?.kind;

    const follows =
      at === index + 1 || before === SyntaxKind.FromKeyword || before === SyntaxKind.OpenParenToken;

    if (token === undefined || clauseEnds.has(token.kind)) {
      return undefined;
    }

    if (token.kind === SyntaxKind.StringLiteral && follows) {
      return token;
    }
  }

  return undefined;
};

/**
 * Every module specifier `text` imports, found in its tokens: static imports and re-exports,
 * `import("x")`, `import x = require("x")` and `require("x")`. A comment or string that merely
 * looks like an import is not a token, so it is not found.
 */
export const importSpecifiers = (text: string): ReadonlyArray<ImportRef> => {
  const tokens = tokenize(text);
  const found = new Map<number, string>();

  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1]?.kind;
    const opens = [SyntaxKind.AsteriskToken, SyntaxKind.OpenBraceToken, SyntaxKind.TypeKeyword];
    const reexport = token.kind === SyntaxKind.ExportKeyword && opens.includes(next ?? 0);

    const call =
      token.value === "require" &&
      next === SyntaxKind.OpenParenToken &&
      tokens[index - 1]?.kind !== SyntaxKind.DotToken;

    const source =
      token.kind === SyntaxKind.ImportKeyword || reexport || call
        ? clauseSource(tokens, index)
        : undefined;

    if (source !== undefined) {
      found.set(source.start, source.value);
    }
  }

  return [...found].map(([start, specifier]) => ({
    line: text.slice(0, start).split("\n").length,
    specifier,
  }));
};

/**
 * Resolves the `.` and `..` segments of the repository path `path`.
 */
const normalize = (path: string): string => {
  const parts: Array<string> = [];

  for (const part of path.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== "." && part !== "") {
      parts.push(part);
    }
  }

  return parts.join("/");
};

/**
 * The directory of the repository path `path`, with no trailing slash.
 */
const dirname = (path: string): string => path.split("/").slice(0, -1).join("/");

/**
 * Whether `path` is inside the `pattern` of a unit.
 */
const inside = (path: string, pattern: string): boolean => {
  const prefix = pattern.replace(/\*\*$/u, "");

  return prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix;
};

/**
 * The fields of a workspace `package.json` that resolve an import. A package whose `exports` is not
 * a plain map of subpath to file does not decode and resolves nothing.
 */
const PackageJson = Schema.Struct({
  exports: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  name: Schema.String,
});

/**
 * A workspace package: its directory and its decoded `package.json`.
 */
interface WorkspacePackage {
  readonly dir: string;
  readonly json: typeof PackageJson.Type;
}

/**
 * The repository paths a specifier written in `from` may mean: a relative path with each extension
 * the repository imports without, or the file a workspace package exports under that subpath.
 */
const candidates = (
  specifier: string,
  from: string,
  packages: ReadonlyArray<WorkspacePackage>,
): ReadonlyArray<string> => {
  const bare = packages.flatMap(({ dir, json }) => {
    const subpath = `.${specifier.slice(json.name.length)}`;
    const named = specifier === json.name || specifier.startsWith(`${json.name}/`);
    const target = named ? json.exports?.[subpath] : undefined;

    return target === undefined ? [] : [normalize(`${dir}/${target}`)];
  });

  const targets = specifier.startsWith(".") ? [normalize(`${dirname(from)}/${specifier}`)] : bare;

  return targets.flatMap((path) => [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`]);
};

/**
 * The matcher for the source files a core scan parses.
 */
const sourceFile = /\.[cm]?[jt]sx?$/u;

/**
 * The matcher for generated source files, which the footprint does not scan: a tool writes them
 * from the other files (`route-tree.gen.ts` from the routes), and the pull-out regenerates them
 * after it removes the unit.
 */
const generatedFile = /\.gen\.[cm]?[jt]sx?$/u;

/**
 * The matcher for the other files the footprint reads: the manifest, packages and READMEs.
 */
const inputFile = /(?:^|\/)(?:blocks\.json|package\.json|README\.md)$/u;

/**
 * The units of the tree `files`: every workspace package whose README starts with a valid `Meter:`
 * line, then every slice and block of its `blocks.json`. A package a slice or block names is not
 * listed twice: the declaration owns the wider path set, and a package-only twin would flag the
 * unit's own files as core.
 */
const discoverUnits = Effect.fn("footprint.discoverUnits")(function* discoverUnits(
  files: Readonly<Record<string, string>>,
  extra: ReadonlyArray<Unit>,
) {
  const pattern = /^(?:(?:apps|packages)\/[^/]+|infra)\/package\.json$/u;

  const dirs = Object.keys(files)
    .filter((file) => pattern.test(file))
    .map(dirname);

  const declared = new Set(extra.map((unit) => unit.name));
  const units: Array<Unit> = [];

  for (const dir of dirs) {
    const name = dir.split("/").at(-1) ?? dir;
    const meter = yield* Effect.result(parseMeter(files[`${dir}/README.md`] ?? ""));

    // A unit `blocks.json` declares by name owns more than its package directory, and wins.
    if (Result.isSuccess(meter) && !declared.has(name)) {
      units.push({ name, paths: [`${dir}/`] });
    }
  }

  return [...units, ...extra];
});

/**
 * The workspace packages of `files`, skipping any whose `package.json` does not decode.
 */
const workspacePackages = Effect.fn("footprint.workspacePackages")(function* workspacePackages(
  files: Readonly<Record<string, string>>,
) {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson));

  const found = yield* Effect.all(
    Object.entries(files)
      .filter(([file]) => file.endsWith("/package.json"))
      .map(([file, text]) =>
        decode(text).pipe(
          Effect.map((json): WorkspacePackage => ({ dir: dirname(file), json })),
          Effect.option,
        ),
      ),
  );

  return found.flatMap(Option.toArray);
});

/**
 * Reads each attach file of `files` as the one form the pull-out reads it as. A line the form
 * cannot read fails the file: a collapsed line naming a unit with the grammar's own message, any
 * other with the file, the line and the shape the form expects.
 */
const attachFailures = Effect.fn("footprint.attachFailures")(function* attachFailures(
  files: Readonly<Record<string, string>>,
  attachFiles: ReadonlyArray<string>,
  units: ReadonlyArray<string>,
) {
  const failures: Array<string> = [];

  for (const file of attachFiles.filter((name) => files[name] !== undefined)) {
    const form = attachFormOf(file);
    const result = yield* Effect.result(parseAttach(form, file, files[file] ?? "", units));

    if (Result.isFailure(result)) {
      const { message } = result.failure;

      failures.push(
        message.startsWith("collapsed attach line")
          ? message
          : unreadableMessage(result.failure, form),
      );
    }
  }

  return failures;
});

/**
 * Measures the footprint of every unit in `files`, a map of tracked repository paths to contents
 * that holds at least `blocks.json`, and returns one line per unit with its elapsed time and one
 * failure per core reference or unreadable attach line. The core of a unit is every file outside
 * its paths and the attach files; an import in the core that resolves into the unit is a failure
 * naming `file:line`, unless the line is one the pull-out deletes (a `block:<unit>` marker) or the
 * file is generated. Attach files are read with the attach grammar, given the unit names.
 */
export const footprint = Effect.fn("footprint.footprint")(function* footprint(
  files: Readonly<Record<string, string>>,
) {
  const manifest = yield* decodeManifest(files["blocks.json"] ?? "");
  const units = yield* discoverUnits(files, [...manifest.slices, ...manifest.blocks]);
  const packages = yield* workspacePackages(files);
  const attach = new Set(manifest.attachFiles);
  const names = units.map((unit) => unit.name);
  const failures = [...(yield* attachFailures(files, manifest.attachFiles, names))];
  const lines: Array<string> = [];

  for (const unit of units) {
    const owns = (path: string): boolean => unit.paths.some((pattern) => inside(path, pattern));

    const resolves = (ref: ImportRef, file: string): boolean => {
      const target = candidates(ref.specifier, file, packages).find((path) => path in files);

      return target !== undefined && owns(target) && !(unit.keep ?? []).includes(target);
    };

    const [elapsed, references] = yield* Effect.timed(
      Effect.sync(() =>
        Object.entries(files)
          .filter(
            ([file]) =>
              sourceFile.test(file) &&
              !generatedFile.test(file) &&
              !attach.has(file) &&
              !owns(file),
          )
          .flatMap(([file, text]) => {
            const removed = markedLines(unit.name, text).lines;

            return importSpecifiers(text)
              .filter((ref) => !removed.has(ref.line) && resolves(ref, file))
              .map(
                (ref) =>
                  `${file}:${ref.line}: core file references ${unit.name} via "${ref.specifier}"`,
              );
          }),
      ),
    );

    failures.push(...references);
    lines.push(
      `${unit.name}: ${references.length} core references, ${Duration.toMillis(elapsed).toFixed(0)} ms`,
    );
  }

  return { failures, lines };
});

/**
 * The tracked files of the repository at `root` that the footprint reads, with their contents.
 */
const trackedFiles = Effect.fn("footprint.trackedFiles")(function* trackedFiles(root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const listing = yield* Effect.scoped(
    Effect.gen(function* list() {
      const git = ChildProcess.make("git", ["ls-files", "-z"], { cwd: root, stderr: "ignore" });

      return yield* Stream.mkString(Stream.decodeText((yield* spawner.spawn(git)).stdout));
    }),
  );

  const wanted = listing
    .split("\0")
    .filter((file) => sourceFile.test(file) || inputFile.test(file));

  const entries = yield* Effect.forEach(
    wanted,
    (file) =>
      fs.readFileString(path.join(root, file)).pipe(Effect.map((text) => [file, text] as const)),
    { concurrency: 16 },
  );

  return Object.fromEntries(entries);
});

/**
 * Prints one line per unit with its elapsed time, then fails naming every core reference.
 */
const main = Effect.gen(function* main() {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const { failures, lines } = yield* footprint(yield* trackedFiles(root));

  yield* Console.log(lines.join("\n"));

  if (failures.length > 0) {
    yield* new FootprintError({ message: failures.join("\n") });
  }
});

if (import.meta.main) {
  BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
}
