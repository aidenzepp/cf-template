import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";

/**
 * The initial-JavaScript target for `web`, in gzipped bytes (1 KiB = 1024 bytes). Source: Alex
 * Russell, "The Performance Inequality Gap, 2026": a JS-light page that loads in 3 s on a median
 * phone over 4G. The target is reported, never enforced.
 */
export const TARGET_KIB = 300;

/**
 * The part of the client chunk graph this check reads: each chunk's file, whether it is an entry,
 * and the keys of its static imports. `dynamicImports` is left out on purpose: a chunk loaded on
 * demand is not initial. `apps/web/vite.config.ts` emits this graph into `dist/server`, outside the
 * asset directory.
 */
export const Chunks = Schema.Record(
  Schema.String,
  Schema.Struct({
    file: Schema.String,
    imports: Schema.optional(Schema.Array(Schema.String)),
    isEntry: Schema.optional(Schema.Boolean),
  }),
);

/**
 * The files of the entry chunks and their static `imports` closure, each once, JavaScript only.
 */
export const initialFiles = (chunks: typeof Chunks.Type): ReadonlyArray<string> => {
  const seen = new Set<string>();

  const visit = (key: string): void => {
    if (!seen.has(key) && chunks[key] !== undefined) {
      seen.add(key);

      for (const imported of chunks[key].imports ?? []) {
        visit(imported);
      }
    }
  };

  for (const [key, chunk] of Object.entries(chunks)) {
    if (chunk.isEntry === true) {
      visit(key);
    }
  }

  return [...seen].flatMap((key) => {
    const { file } = chunks[key] ?? { file: "" };

    return file.endsWith(".js") ? [file] : [];
  });
};

/**
 * The lines printed on every run: the measured size beside the target, then a warning when over.
 */
export const report = (gzipBytes: number): ReadonlyArray<string> => {
  const kib = gzipBytes / 1024;
  const line = `initial JS: ${kib.toFixed(1)} / ${TARGET_KIB} KiB gzipped`;

  return kib > TARGET_KIB
    ? [line, `warning: initial JS is over the ${TARGET_KIB} KiB target`]
    : [line];
};

/**
 * Raised when the gzip stream of a chunk fails.
 */
class GzipError extends Schema.TaggedError<GzipError>()("GzipError", {
  cause: Schema.Defect(),
}) {}

/**
 * The gzipped byte length of `bytes`, from the platform `CompressionStream`.
 */
const gzipLength = Effect.fn("bundle.gzipLength")(function* gzipLength(bytes: Uint8Array) {
  const gzipped = yield* Effect.tryPromise({
    catch: (cause) => new GzipError({ cause }),
    try: () =>
      new Response(
        new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
  });

  return gzipped.byteLength;
});

/**
 * Sums the gzipped size of the graph's initial JavaScript, reading each file under `clientDir`.
 */
export const initialGzipBytes = Effect.fn("bundle.initialGzipBytes")(function* initialGzipBytes(
  graphFile: string,
  clientDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const chunks = yield* fs
    .readFileString(graphFile)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Chunks))));

  const sizes = yield* Effect.all(
    initialFiles(chunks).map((file) =>
      fs.readFile(path.join(clientDir, file)).pipe(Effect.flatMap(gzipLength)),
    ),
  );

  return sizes.reduce((sum, size) => sum + size, 0);
});

/**
 * A warning line when the Worker asset directory `clientDir` holds a Vite manifest, which would be
 * served publicly at `/.vite/manifest.json`; no lines when it does not.
 */
export const manifestLeak = Effect.fn("bundle.manifestLeak")(function* manifestLeak(
  clientDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const leaked = yield* fs.exists(path.join(clientDir, ".vite/manifest.json"));

  return leaked
    ? [
        "warning: Vite manifest found in the Worker asset directory (served publicly at /.vite/manifest.json)",
      ]
    : [];
});

/**
 * Prints the report and appends it to the CI job summary when `GITHUB_STEP_SUMMARY` names a file.
 * Any failure to measure becomes a warning line; this check never fails the build.
 */
const main = Effect.gen(function* main() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const web = yield* path.fromFileUrl(new URL("../../apps/web/", import.meta.url));
  const clientDir = path.join(web, "dist/client");

  const sizeLines = yield* initialGzipBytes(
    path.join(web, "dist/server/chunk-graph.json"),
    clientDir,
  ).pipe(
    Effect.map(report),
    Effect.catch((error) => Effect.succeed([`warning: initial JS not measured: ${error.message}`])),
  );

  const leakLines = yield* manifestLeak(clientDir).pipe(
    Effect.catch((error) =>
      Effect.succeed([`warning: asset directory not checked: ${error.message}`]),
    ),
  );

  const lines = [...sizeLines, ...leakLines];

  yield* Console.log(lines.join("\n"));

  const summary = yield* Config.option(Config.String("GITHUB_STEP_SUMMARY"));

  if (Option.isSome(summary)) {
    yield* fs.writeFileString(summary.value, `${lines.join("\n\n")}\n`, { flag: "a" });
  }
});

if (import.meta.main) {
  BunRuntime.runMain(
    main.pipe(
      Effect.catchCause((cause) =>
        Console.log(`warning: initial JS summary not written: ${Cause.pretty(cause)}`),
      ),
      Effect.provide(BunServices.layer),
    ),
  );
}
