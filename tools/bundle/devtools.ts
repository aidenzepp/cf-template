import { Effect, FileSystem, Path, Schema } from "effect";

/**
 * Strings that only appear in a client file when Router devtools code is bundled: the package
 * names, which survive minification inside dynamic-import and error strings, and the exported
 * component names, which survive in the devtools' own `displayName` and log text.
 */
const DEVTOOLS_MARKERS: ReadonlyArray<string> = [
  "@tanstack/react-router-devtools",
  "@tanstack/router-devtools",
  "@tanstack/router-devtools-core",
  "TanStackRouterDevtools",
];

/**
 * The marker lines for files whose text holds a devtools marker; no lines when none does.
 */
export const devtoolsHits = (
  files: ReadonlyArray<{ readonly file: string; readonly text: string }>,
) =>
  files.flatMap(({ file, text }) => {
    const marker = DEVTOOLS_MARKERS.find((candidate) => text.includes(candidate));

    return marker === undefined ? [] : [`${file}: contains "${marker}"`];
  });

/**
 * Raised when a client file holds Router devtools code, which must never ship in production.
 */
export class DevtoolsInBundleError extends Schema.TaggedError<
  DevtoolsInBundleError,
  { readonly brand: unique symbol }
>()("DevtoolsInBundleError", { files: Schema.Array(Schema.String), message: Schema.String }) {}

/**
 * Fails with {@link DevtoolsInBundleError} when any JavaScript file under `clientDir` holds Router
 * devtools code. Reads file content, so it covers lazy chunks as well as the initial graph.
 */
export const assertNoDevtools = Effect.fn("bundle.assertNoDevtools")(function* assertNoDevtools(
  clientDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(clientDir, { recursive: true });

  const files = yield* Effect.forEach(
    names.filter((name) => name.endsWith(".js")),
    (name) =>
      fs
        .readFileString(path.join(clientDir, name))
        .pipe(Effect.map((text) => ({ file: name, text }))),
  );

  const hits = devtoolsHits(files);

  return yield* hits.length > 0
    ? new DevtoolsInBundleError({
        files: hits,
        message: `Router devtools code in the production client bundle:\n${hits.join("\n")}`,
      })
    : Effect.void;
});
