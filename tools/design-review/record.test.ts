import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { RecordError, checkRecord, isReviewed, recordLine, sameChange } from "./record.ts";

const head = "a".repeat(40);

const other = "b".repeat(40);

const never = () => Effect.succeed(false);

const line = (sha: string, verdict = "pass") => `design-review: ${sha} ${verdict} Looks right.`;

describe("recordLine", () => {
  it.effect("matches the format the skill documents", () =>
    Effect.gen(function* skill() {
      const fs = yield* FileSystem.FileSystem;

      const text = yield* fs.readFileString(
        `${import.meta.dirname}/../../.agents/skills/design-review/SKILL.md`,
      );

      assert.include(text, "design-review: <40-hex head sha> <pass|concerns|fail> <reason>");

      const groups = recordLine.exec(line(head, "concerns"))?.groups;

      assert.strictEqual(groups?.sha, head);
      assert.strictEqual(groups?.verdict, "concerns");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it("rejects a short sha and an unknown verdict", () => {
    assert.isNull(recordLine.exec(line("abc123")));
    assert.isNull(recordLine.exec(line(head, "maybe")));
  });
});

describe("checkRecord", () => {
  it.effect("fails a reviewed path with no record", () =>
    Effect.gen(function* missing() {
      const error = yield* Effect.flip(checkRecord(["apps/web/src/a.ts"], "text", head, never));

      assert.instanceOf(error, RecordError);
    }),
  );

  it.effect("passes with the head line, whatever the verdict", () =>
    checkRecord(["apps/web/src/a.ts"], `x\n${line(head, "fail")}\ny`, head, never),
  );

  it.effect("fails again once a push makes the line stale", () =>
    Effect.gen(function* stale() {
      const error = yield* Effect.flip(checkRecord(["packages/ui/a.ts"], line(head), other, never));

      assert.instanceOf(error, RecordError);
    }),
  );

  it.effect("skips a pull request that touches neither path", () =>
    checkRecord(["apps/api/a.ts", "tools/x.ts"], "", head, never),
  );

  it("covers only apps/web and packages/ui files", () => {
    assert.isTrue(isReviewed("packages/ui/src/button.tsx"));
    assert.isFalse(isReviewed("apps/web-extra/a.ts"));
  });

  it.effect("keeps the old record valid for a head that merged main", () => {
    const recorded =
      "diff --git a/apps/web/a.ts b/apps/web/a.ts\nindex 111..222 100644\n@@ -1,0 +2 @@\n+x";

    const merged =
      "diff --git a/apps/web/a.ts b/apps/web/a.ts\nindex 333..444 100644\n@@ -9,0 +10 @@\n+x";

    return checkRecord(["apps/web/a.ts"], line(other), head, (sha) =>
      Effect.succeed(sha === other && sameChange(recorded, merged)),
    );
  });

  it.effect("fails once a reviewed file changes after the record", () =>
    Effect.gen(function* edited() {
      const recorded = "diff --git a/apps/web/a.ts b/apps/web/a.ts\n@@ -1,0 +2 @@\n+x";
      const later = `${recorded}\n+y`;

      const error = yield* Effect.flip(
        checkRecord(["apps/web/a.ts"], line(other), head, (sha) =>
          Effect.succeed(sha === other && sameChange(recorded, later)),
        ),
      );

      assert.instanceOf(error, RecordError);
    }),
  );

  it.effect("needs no record when only tests change under apps/web", () =>
    checkRecord(["apps/web/src/a.test.ts", "apps/web/src/b.test.tsx"], "", head, never),
  );
});
