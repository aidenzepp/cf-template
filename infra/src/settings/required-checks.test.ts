import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { CLOUD_STAGE } from "../../stages.ts";
import { REQUIRED_CHECKS } from "./required-checks.ts";

/**
 * Split one workflow file into its jobs. It reads the two-space job keys under the top-level
 * `jobs:` and keeps each job's lines up to the next job key, which is how every workflow here is
 * laid out.
 *
 * @param text - The workflow file.
 * @returns Each job's id and its lines after the key, in file order.
 */
const jobBlocks = (text: string) => {
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

    return [{ id, lines: next === -1 ? rest : rest.slice(0, next) }];
  });
};

/**
 * The status contexts the jobs of one workflow file report: each job's `name`, or its id when it
 * has none. It reads a `name:` four spaces in, which is how every workflow here is laid out; a
 * matrix job's expanded names are out of reach.
 *
 * @param text - The workflow file.
 * @returns The contexts, in file order.
 */
const jobContexts = (text: string) =>
  jobBlocks(text).map(({ id, lines }) => {
    const name = lines
      .map((line) => /^ {4}name:\s*["']?(?<name>.+?)["']?\s*$/u.exec(line)?.groups?.name)
      .find((found) => found !== undefined);

    return name ?? id;
  });

/**
 * Read the `concurrency.group` of every job that runs `bun run test:cloud`. It reads the
 * four-space `concurrency:` key of a job in either form, a scalar group or a mapping with a
 * six-space `group:`.
 *
 * @param text - The workflow file.
 * @returns Each such job's id and its group, `undefined` when the job names none.
 */
const cloudJobGroups = (text: string) =>
  jobBlocks(text)
    .filter(({ lines }) =>
      lines.some((line) => /^\s*(?:-\s+)?run:\s*bun run test:cloud(?:\s|$)/u.test(line)),
    )
    .map(({ id, lines }) => {
      const key = lines.findIndex((line) => /^ {4}concurrency:/u.test(line));
      const after = lines.slice(key + 1);
      const end = after.findIndex((line) => /^ {0,4}\S/u.test(line));
      const block = end === -1 ? after : after.slice(0, end);
      const scalar = /^ {4}concurrency:\s*["']?(?<group>[^"'#\s]+)["']?/u.exec(lines[key] ?? "");

      const mapped = block
        .map((line) => /^ {6}group:\s*["']?(?<group>[^"'#\s]+)["']?\s*(?:#.*)?$/u.exec(line))
        .find((found) => found !== null);

      return {
        group: key === -1 ? undefined : (scalar?.groups?.group ?? mapped?.groups?.group),
        id,
      };
    });

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

  it("reads the concurrency group of a job that runs the cloud suite, in either form", () => {
    const workflow = [
      "jobs:",
      "  unit:",
      "    concurrency:",
      "      group: other",
      "    steps:",
      "      - run: bun run test",
      "  mapped:",
      "    concurrency:",
      "      group: test-ci",
      "      cancel-in-progress: false",
      "    steps:",
      "      - run: bun run test:cloud",
      "  scalar:",
      "    concurrency: test-ci",
      "    steps:",
      "      - run: bun run test:cloud",
      "  bare:",
      "    steps:",
      "      - run: bun run test:cloud",
      "    env:",
      "      other: 1",
    ].join("\n");

    assert.deepStrictEqual(cloudJobGroups(workflow), [
      { group: "test-ci", id: "mapped" },
      { group: "test-ci", id: "scalar" },
      { group: undefined, id: "bare" },
    ]);
  });

  it.effect("serializes every cloud job on the cloud stage", () =>
    Effect.gen(function* sameGroup() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const directory = yield* path.fromFileUrl(
        new URL("../../../.github/workflows", import.meta.url),
      );

      const files = (yield* fs.readDirectory(directory)).filter((file) => /\.ya?ml$/u.test(file));

      const jobs = (yield* Effect.forEach(
        files,
        (file) =>
          fs
            .readFileString(path.join(directory, file))
            .pipe(Effect.map((text) => cloudJobGroups(text).map((job) => ({ ...job, file })))),
        { concurrency: "unbounded" },
      )).flat();

      assert.isAbove(jobs.length, 0, "no workflow job runs `bun run test:cloud`");

      assert.deepStrictEqual(
        jobs
          .filter(({ group }) => group !== CLOUD_STAGE)
          .map(
            ({ file, group, id }) =>
              `.github/workflows/${file} job ${id}: concurrency.group is ${group ?? "missing"}, expected ${CLOUD_STAGE} (CLOUD_STAGE in infra/stages.ts)`,
          ),
        [],
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
