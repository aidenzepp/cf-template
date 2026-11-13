import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { REQUIRED_CHECKS } from "./declare.ts";

/**
 * The status contexts the jobs of one workflow file report: each job's `name`, or its id when it
 * has none. It reads the two-space job keys under the top-level `jobs:` and a `name:` four spaces
 * in, which is how every workflow here is laid out; a matrix job's expanded names are out of reach.
 *
 * @param text - The workflow file.
 * @returns The contexts, in file order.
 */
const jobContexts = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");

  if (start === -1) {
    return [];
  }

  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => /^\S/u.test(line));
  const jobs = end === -1 ? body : body.slice(0, end);

  return jobs.flatMap((line, index) => {
    const id = /^ {2}(?<id>[\w-]+):\s*$/u.exec(line)?.groups?.id;

    if (id === undefined) {
      return [];
    }

    const rest = jobs.slice(index + 1);
    const next = rest.findIndex((other) => /^ {2}\S/u.test(other));
    const own = next === -1 ? rest : rest.slice(0, next);

    const name = own
      .map((other) => /^ {4}name:\s*["']?(?<name>.+?)["']?\s*$/u.exec(other)?.groups?.name)
      .find((found) => found !== undefined);

    return [name ?? id];
  });
};

describe("REQUIRED_CHECKS", () => {
  it("reads job ids, and a job's name over its id", () => {
    const workflow = [
      "on: push",
      "jobs:",
      "  lint:",
      "    runs-on: ubuntu-latest",
      "  gate:",
      '    name: "merge gate"',
      "    steps: []",
      "env:",
      "  other: 1",
    ].join("\n");

    assert.deepStrictEqual(jobContexts(workflow), ["lint", "merge gate"]);
  });

  it.effect("names only Actions contexts a job under .github/workflows reports", () =>
    Effect.gen(function* declaredContexts() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const directory = yield* path.fromFileUrl(
        new URL("../../../.github/workflows", import.meta.url),
      );

      const files = (yield* fs.readDirectory(directory)).filter((file) => /\.ya?ml$/u.test(file));

      const texts = yield* Effect.forEach(
        files,
        (file) => fs.readFileString(path.join(directory, file)),
        { concurrency: "unbounded" },
      );

      const reported = new Set(texts.flatMap((text) => jobContexts(text)));

      const actions = REQUIRED_CHECKS.filter((context) => context !== "reviewer-agent");

      assert.deepStrictEqual(
        actions.filter((context) => !reported.has(context)),
        [],
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
