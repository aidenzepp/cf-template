import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

/**
 * The route options the system pages own: a route that sets one bypasses the router defaults.
 */
const FORBIDDEN = /\b(?:notFoundComponent|errorComponent)\b/u;

it.effect("no route file sets notFoundComponent or errorComponent", () =>
  Effect.gen(function* routes() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* path.fromFileUrl(new URL("routes", import.meta.url));

    const files = (yield* fs.readDirectory(dir, { recursive: true })).filter(
      (file) => /\.tsx?$/u.test(file) && !path.basename(file).startsWith("-harness-"),
    );

    expect(files).not.toHaveLength(0);

    const offenders: Array<string> = [];

    for (const file of files) {
      const text = yield* fs.readFileString(path.join(dir, file));

      if (FORBIDDEN.test(text)) {
        offenders.push(file);
      }
    }

    expect(offenders).toStrictEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
