import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import {
  PrBodyError,
  check,
  expectedDisclosure,
  hasDisclosure,
  hasNoIssue,
  isExempt,
  parseLinks,
  problems,
  stripCode,
} from "./rules.ts";

const disclosure = "---\n**AI disclosure:**\n- **Provider:** Anthropic\n- **Model:** Sonnet 5.5";

/**
 * Shaped like #431: `Closes #N.` ends the opening paragraph, and two models wrote it.
 */
const fixed = [
  "> Written by an AI agent on behalf of @someone. @someone has not reviewed it yet.",
  "",
  "The `cloud` job fails at the deploy step. 5 of 24 runs ended this way. Closes #430.",
  "",
  "### What changed",
  "- `test/cloud/global-setup.ts`: retries the deploy.",
  "",
  "---",
  "**AI disclosure:**",
  "- **Provider:** Anthropic",
  "- **Model:** Sonnet 5.5",
  "- **Provider:** Anthropic",
  "- **Model:** Fable 5.2",
].join("\n");

/**
 * Shaped like #400: a partial delivery, `Refs #N.` alone on its line.
 */
const partial = [
  "> Written by an AI agent on behalf of @someone, following their spec.",
  "",
  "The notes Api can write a note but not read it.",
  "",
  "Refs #262.",
  "",
  "### What changed",
  "",
  disclosure,
].join("\n");

/**
 * Shaped like release PR 439: no issue link and no disclosure.
 */
const release = [
  ":robot: I have created a release *beep* *boop*",
  "---",
  "",
  "## [0.1.3](https://example.test/compare/v0.1.2...v0.1.3) (2026-11-24)",
  "",
  "### Features",
  "",
  "* **ui:** install every component ([#438](https://example.test/issues/438))",
].join("\n");

const noDisclosure = "A fix.\n\nCloses #12.\n\n### ELI5\n\nIt works now.";

const user = { authorType: "User", branch: "fix/x" };

describe("stripCode", () => {
  it("removes fenced blocks, tilde fences and unclosed fences", () => {
    assert.notInclude(stripCode("a\n```text\nCloses #1\n```\nb"), "Closes");
    assert.notInclude(stripCode("a\n~~~\nCloses #1\n~~~\nb"), "Closes");
    assert.notInclude(stripCode("a\n```\nCloses #1\nstill code"), "Closes");
    assert.include(stripCode("a\n```\n```\nCloses #1"), "Closes #1");
  });

  it("removes inline code and keeps a lone backtick's neighbours", () => {
    assert.notInclude(stripCode("write `Closes #1` here"), "Closes");
    assert.notInclude(stripCode("write ``Closes #1 ` x`` here"), "Closes");
    assert.include(stripCode("a ` b\n\nCloses #1 ` c"), "Closes #1");
  });

  it("reads a body saved with CRLF line endings", () => {
    assert.deepStrictEqual(parseLinks("x\r\n\r\n```\r\nCloses #1\r\n```\r\nCloses #2"), [
      { issue: 2, keyword: "Closes" },
    ]);
  });
});

describe("parseLinks", () => {
  it("finds a link inside a paragraph, not only alone on a line", () => {
    assert.deepStrictEqual(parseLinks(fixed), [{ issue: 430, keyword: "Closes" }]);
    assert.deepStrictEqual(parseLinks(partial), [{ issue: 262, keyword: "Refs" }]);
  });

  it("finds Part of, in any case, with or without a colon", () => {
    assert.deepStrictEqual(parseLinks("Part of #7.\npart of: #8\nCLOSES #9"), [
      { issue: 7, keyword: "Part of" },
      { issue: 8, keyword: "Part of" },
      { issue: 9, keyword: "Closes" },
    ]);
  });

  it("ignores a reference with no keyword, a pull request link and a malformed number", () => {
    assert.deepStrictEqual(
      parseLinks("See #5 and ([#438](https://x.test/issues/438)). Refs #12a"),
      [],
    );
  });

  it("ignores a keyword inside code", () => {
    assert.deepStrictEqual(parseLinks("Use `Closes #1`.\n\n```md\nRefs #2\n```"), []);
  });
});

describe("hasNoIssue", () => {
  it("passes a line `No issue: <reason>` alone on its line", () => {
    assert.isTrue(hasNoIssue("Text.\n\nNo issue: a template-only cleanup.\n\nMore."));
  });

  it("fails an empty reason, a line with text before it and code", () => {
    assert.isFalse(hasNoIssue("No issue:"));
    assert.isFalse(hasNoIssue("There is No issue: here"));
    assert.isFalse(hasNoIssue("`No issue: x`\n\n```\nNo issue: y\n```"));
  });
});

describe("hasDisclosure", () => {
  it("accepts the shape of #431 with two authors, and a single pair", () => {
    assert.isTrue(hasDisclosure(fixed));
    assert.isTrue(hasDisclosure(partial));
  });

  it("rejects a missing label, a missing Model, an empty value and a disclosure inside code", () => {
    assert.isFalse(hasDisclosure(noDisclosure));
    assert.isFalse(hasDisclosure("**AI disclosure:**\n- **Provider:** Anthropic"));
    assert.isFalse(hasDisclosure("**AI disclosure:**\n- **Provider:** Anthropic\n- **Model:**"));
    assert.isFalse(hasDisclosure("**AI disclosure:**\nnote\n- **Provider:** A\n- **Model:** B"));
    assert.isFalse(hasDisclosure(`\`\`\`md\n${disclosure}\n\`\`\``));
  });

  it("matches the block the failure message shows, with or without the blank lines a formatter adds", () => {
    assert.isTrue(hasDisclosure(expectedDisclosure));
    assert.isTrue(hasDisclosure("**AI disclosure:**\n\n- **Provider:** A\n- **Model:** B"));
    assert.isTrue(hasDisclosure("**AI disclosure:**\r\n\r\n- **Provider:** A\r\n- **Model:** B"));
  });
});

describe("isExempt", () => {
  it("exempts a Release Please or Renovate branch opened by a Bot", () => {
    assert.isTrue(isExempt({ authorType: "Bot", branch: "release-please--branches--main" }));
    assert.isTrue(isExempt({ authorType: "Bot", branch: "renovate/effect-4.x" }));
  });

  it("checks a person on the same branch and a Bot on another branch", () => {
    assert.isFalse(isExempt({ authorType: "User", branch: "release-please--branches--main" }));
    assert.isFalse(isExempt({ authorType: "User", branch: "renovate/effect-4.x" }));
    assert.isFalse(isExempt({ authorType: "Bot", branch: "feat/x" }));
  });
});

describe("problems", () => {
  it("passes the bodies of #431 and #400", () => {
    assert.deepStrictEqual(problems(fixed), []);
    assert.deepStrictEqual(problems(partial), []);
  });

  it("passes No issue: with a disclosure", () => {
    assert.deepStrictEqual(problems(`No issue: a typo.\n\n${disclosure}`), []);
  });

  it("names a missing link and a missing disclosure", () => {
    const found = problems("A body.");

    assert.strictEqual(found.length, 2);
    assert.include(found[0], "links no issue");
    assert.include(found[1], "no AI disclosure");
  });

  it("names every other closing keyword", () => {
    for (const word of [
      "close",
      "closed",
      "fix",
      "fixes",
      "fixed",
      "resolve",
      "resolves",
      "resolved",
    ]) {
      const found = problems(`${word} #3.\n\n${disclosure}`);

      assert.strictEqual(found.length, 2, word);
      assert.include(found[0], `${word} #3`);
    }
  });

  it("names a closing keyword even next to a valid link", () => {
    const found = problems(`Fixes #3. Closes #4.\n\n${disclosure}`);

    assert.strictEqual(found.length, 1);
    assert.include(found[0], "Fixes #3");
  });

  it("names the same issue under a closing and a non-closing keyword", () => {
    const found = problems(`Closes #5.\n\nPart of #5.\n\n${disclosure}`);

    assert.strictEqual(found.length, 1);
    assert.include(found[0], "#5 appears under");
  });

  it("allows different issues under different keywords", () => {
    assert.deepStrictEqual(problems(`Closes #5.\n\nRefs #6.\n\n${disclosure}`), []);
  });

  it("names a Closes list and accepts one keyword for each issue", () => {
    const found = problems(`Closes #1, #2.\n\n${disclosure}`);

    assert.strictEqual(found.length, 1);
    assert.include(found[0], "Closes #1, #2");
    assert.deepStrictEqual(problems(`Closes #1, closes #2.\n\n${disclosure}`), []);
  });

  it("ignores keywords inside code", () => {
    assert.deepStrictEqual(problems(`Refs #1. Write \`Fixes #2\`.\n\n${disclosure}`), []);
  });
});

describe("check", () => {
  it.effect("passes the bodies of #431 and #400 and a body with No issue", () =>
    Effect.gen(function* passes() {
      yield* check({ ...user, body: fixed });
      yield* check({ ...user, body: partial });
      yield* check({ ...user, body: `No issue: a typo.\n\n${disclosure}` });
    }),
  );

  it.effect("fails a body with no disclosure", () =>
    Effect.gen(function* missing() {
      const error = yield* Effect.flip(check({ ...user, body: noDisclosure }));

      assert.instanceOf(error, PrBodyError);
      assert.deepStrictEqual(error.problems.length, 1);
      assert.include(error.message, "no AI disclosure");
    }),
  );

  it.effect("carries every problem and shows the expected block", () =>
    Effect.gen(function* all() {
      const error = yield* Effect.flip(check({ ...user, body: "Fixes #1. Closes #2, #3." }));

      assert.strictEqual(error.problems.length, 3);

      for (const problem of error.problems) {
        assert.include(error.message, problem);
      }

      assert.include(error.message, expectedDisclosure);
      assert.include(error.message, "Closes #<issue>.");
    }),
  );

  it.effect("skips the release PR and a Renovate PR, and checks a person's release branch", () =>
    Effect.gen(function* exempt() {
      yield* check({ authorType: "Bot", body: release, branch: "release-please--branches--main" });
      yield* check({ authorType: "Bot", body: "", branch: "renovate/effect-4.x" });

      const error = yield* Effect.flip(
        check({ authorType: "User", body: release, branch: "release-please--branches--main" }),
      );

      assert.instanceOf(error, PrBodyError);
    }),
  );
});

describe("pull request template", () => {
  it.effect("carries the disclosure block, and its issue line fails the rule until filled in", () =>
    Effect.gen(function* template() {
      const fs = yield* FileSystem.FileSystem;

      const text = yield* fs.readFileString(
        `${import.meta.dirname}/../../.github/pull_request_template.md`,
      );

      assert.isTrue(hasDisclosure(text));
      assert.strictEqual(problems(text).length, 1);
      assert.include(problems(text)[0], "links no issue");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
