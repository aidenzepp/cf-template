import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { MergeNoteError, program } from "./merge-note.ts";
import { MERGE_NOTE_CAP, mergeNote, mergeNoteMarker, needsNote, parseLinks } from "./rules.ts";

const disclosure = "---\n**AI disclosure:**\n- **Provider:** Anthropic\n- **Model:** Sonnet 5.5";

/**
 * What a stubbed `gh` call exits with and prints.
 */
interface Reply {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A call that succeeds with `stdout`.
 */
const ok = (stdout: string): Reply => ({ code: 0, stderr: "", stdout });

/**
 * A call GitHub answers with an HTTP error, as `gh api` reports it.
 */
const refused = (status: number, text: string): Reply => ({
  code: 1,
  stderr: `gh: ${text} (HTTP ${status})`,
  stdout: "",
});

/**
 * Encode a stubbed stream's text.
 */
const bytes = (text: string) => Stream.make(new TextEncoder().encode(text));

/**
 * A spawner that records every `gh` argument list and answers it from `reply` without starting a
 * process.
 */
const stubSpawner = (
  seen: Array<ReadonlyArray<string>>,
  reply: (args: ReadonlyArray<string>) => Reply,
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const standard = ChildProcess.isStandardCommand(command) ? command : undefined;
        const args = (standard?.args ?? []).map(String);
        seen.push([standard?.command ?? "", ...args]);

        const { code, stderr, stdout } = reply(args);

        return ChildProcessSpawner.makeHandle({
          all: Stream.concat(bytes(stdout), bytes(stderr)),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(1),
          stderr: bytes(stderr),
          stdin: Sink.drain,
          stdout: bytes(stdout),
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

/**
 * The comment bodies the job posted: the `-f body=...` of each `POST`, with the issue number.
 */
const posts = (seen: ReadonlyArray<ReadonlyArray<string>>) =>
  seen.flatMap((args) =>
    args.includes("POST")
      ? [
          {
            body: args.find((arg) => arg.startsWith("body="))?.slice("body=".length) ?? "",
            issue: Number(
              /issues\/(?<issue>\d+)\/comments$/u.exec(args.at(-3) ?? "")?.groups?.issue,
            ),
          },
        ]
      : [],
  );

/**
 * A stand-in for GitHub: every target is an issue with no comments, unless `reply` says otherwise.
 */
const quiet = (args: ReadonlyArray<string>): Reply => {
  if (args.includes("POST")) {
    return ok("{}");
  }

  return args.includes("--paginate") ? ok("") : ok("false");
};

/**
 * Runs the merge-note program against stubbed `gh` calls and the given pull request.
 */
const run = (
  pull: Partial<Record<string, string>>,
  reply: (args: ReadonlyArray<string>) => Reply = quiet,
) => {
  const seen: Array<ReadonlyArray<string>> = [];

  const config = {
    PR_AUTHOR_TYPE: "User",
    PR_BODY: "",
    PR_BRANCH: "feat/x",
    PR_NUMBER: "446",
    PR_TITLE: "feat(tools): note an issue when a pull request merges",
    ...pull,
  };

  return program.pipe(
    Effect.provide(
      Layer.mergeAll(
        stubSpawner(seen, reply),
        ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
      ),
    ),
    Effect.map((posted) => ({ posted, seen })),
  );
};

const marker = mergeNoteMarker(446);

describe("mergeNote", () => {
  it("writes the marker line, then `#<number> merged: <title>.`", () => {
    const note = mergeNote("fix(api): read a note", 12, parseLinks("Part of #7."));

    assert.strictEqual(note.marker, "<!-- pr-merge-note:12 -->");
    assert.strictEqual(note.body, "<!-- pr-merge-note:12 -->\n#12 merged: fix(api): read a note.");
    assert.deepStrictEqual(note.issues, [7]);
    assert.strictEqual(note.dropped, 0);
  });

  it("names each distinct issue under Part of or Refs once, in order", () => {
    assert.deepStrictEqual(
      mergeNote("t", 1, parseLinks("Part of #5. Refs #6. part of #5. Refs #4.")).issues,
      [5, 6, 4],
    );
  });

  it("names no issue under Closes, even when it also appears under Part of", () => {
    assert.deepStrictEqual(mergeNote("t", 1, parseLinks("Closes #7.")).issues, []);
    assert.deepStrictEqual(
      mergeNote("t", 1, parseLinks("Closes #7. Part of #7. Refs #8.")).issues,
      [8],
    );
  });

  it("caps the issues at ten and counts the rest", () => {
    const body = Array.from({ length: 12 }, (_, index) => `Refs #${index + 1}.`).join(" ");
    const note = mergeNote("t", 1, parseLinks(body));

    assert.strictEqual(MERGE_NOTE_CAP, 10);
    assert.deepStrictEqual(note.issues, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.strictEqual(note.dropped, 2);
  });
});

describe("needsNote", () => {
  it("is false when a comment carries the marker, and true otherwise", () => {
    assert.isFalse(needsNote(["hello", `${marker}\n#446 merged: x.`], marker));
    assert.isTrue(needsNote(["hello", "<!-- pr-merge-note:4460 -->"], marker));
    assert.isTrue(needsNote([], marker));
  });
});

describe("merge-note program", () => {
  it.effect("posts one note on each distinct issue under Part of or Refs", () =>
    Effect.gen(function* distinct() {
      const { posted, seen } = yield* run({
        PR_BODY: `Part of #5. Refs #6. Part of #5.\n\n${disclosure}`,
      });

      assert.deepStrictEqual(posted, [5, 6]);
      assert.deepStrictEqual(posts(seen), [
        {
          body: `${marker}\n#446 merged: feat(tools): note an issue when a pull request merges.`,
          issue: 5,
        },
        {
          body: `${marker}\n#446 merged: feat(tools): note an issue when a pull request merges.`,
          issue: 6,
        },
      ]);
      assert.isTrue(seen.every((args) => args[0] === "gh" && args[1] === "api"));
    }),
  );

  it.effect("posts nothing for Closes", () =>
    Effect.gen(function* closes() {
      const { posted, seen } = yield* run({ PR_BODY: `Closes #7.\n\n${disclosure}` });

      assert.deepStrictEqual(posted, []);
      assert.strictEqual(seen.length, 0);
    }),
  );

  it.effect("posts nothing when the issue already has the marker", () =>
    Effect.gen(function* repeated() {
      const { posted, seen } = yield* run({ PR_BODY: "Refs #5." }, (args) =>
        args.includes("--paginate")
          ? ok(`an older comment\n${marker}\n#446 merged: x.`)
          : quiet(args),
      );

      assert.deepStrictEqual(posted, []);
      assert.strictEqual(posts(seen).length, 0);
    }),
  );

  it.effect("posts nothing when the target is a pull request", () =>
    Effect.gen(function* pull() {
      const { posted, seen } = yield* run({ PR_BODY: "Refs #5." }, (args) =>
        args.includes("--jq") && !args.includes("--paginate") ? ok("true\n") : quiet(args),
      );

      assert.deepStrictEqual(posted, []);
      assert.strictEqual(seen.length, 1);
    }),
  );

  it.effect("stops at ten issues", () =>
    Effect.gen(function* capped() {
      const body = Array.from({ length: 12 }, (_, index) => `Refs #${index + 1}.`).join(" ");
      const { posted, seen } = yield* run({ PR_BODY: body });

      assert.deepStrictEqual(posted, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.strictEqual(posts(seen).length, 10);
    }),
  );

  it.effect("skips a release PR and a Renovate PR without calling gh", () =>
    Effect.gen(function* exempt() {
      const release = yield* run({
        PR_AUTHOR_TYPE: "Bot",
        PR_BODY: "Refs #5.",
        PR_BRANCH: "release-please--branches--main",
      });

      const renovate = yield* run({
        PR_AUTHOR_TYPE: "Bot",
        PR_BODY: "Refs #5.",
        PR_BRANCH: "renovate/effect-4.x",
      });

      assert.strictEqual(release.seen.length + renovate.seen.length, 0);
      assert.deepStrictEqual([...release.posted, ...renovate.posted], []);
    }),
  );

  it.effect("notes a person's release-please branch like any other", () =>
    Effect.gen(function* person() {
      const { posted } = yield* run({
        PR_BODY: "Refs #5.",
        PR_BRANCH: "release-please--branches--main",
      });

      assert.deepStrictEqual(posted, [5]);
    }),
  );

  it.effect("warns and skips an issue GitHub answers with 404 or 422, then notes the next", () =>
    Effect.gen(function* missing() {
      const { posted, seen } = yield* run({ PR_BODY: "Refs #5. Refs #6. Refs #7." }, (args) => {
        if (args.some((arg) => arg.endsWith("/issues/5"))) {
          return refused(404, "Not Found");
        }

        if (args.some((arg) => arg.endsWith("/issues/6/comments")) && args.includes("POST")) {
          return refused(422, "Validation Failed");
        }

        return quiet(args);
      });

      assert.deepStrictEqual(posted, [7]);
      assert.deepStrictEqual(
        posts(seen).map((post) => post.issue),
        [6, 7],
      );
    }),
  );

  it.effect("fails on any other API error", () =>
    Effect.gen(function* failed() {
      const error = yield* Effect.flip(
        run({ PR_BODY: "Refs #5." }, () => refused(500, "Server Error")),
      );

      assert.instanceOf(error, MergeNoteError);
      assert.include(error.message, "#5");
      assert.include(error.message, "HTTP 500");
    }),
  );

  it.effect("fails when gh refuses the token", () =>
    Effect.gen(function* forbidden() {
      const error = yield* Effect.flip(
        run({ PR_BODY: "Refs #5." }, (args) =>
          args.includes("POST")
            ? refused(403, "Resource not accessible by integration")
            : quiet(args),
        ),
      );

      assert.instanceOf(error, MergeNoteError);
      assert.include(error.message, "comment on #5");
      assert.include(error.message, "HTTP 403");
    }),
  );
});
