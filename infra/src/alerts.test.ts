import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import type { StageName } from "../stages.ts";
import { ISSUE_NOTIFICATION_STEP, issueNotificationAddress } from "./alerts.ts";

/**
 * Read the notification address of `stage` from a provider holding a fake address.
 *
 * @param stage - The decoded stage.
 * @returns The address the stage reads, if any.
 */
const readWith = (stage: StageName) =>
  issueNotificationAddress(stage).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ ISSUE_NOTIFICATION_EMAIL: "a@example.invalid" }),
      ),
    ),
  );

describe("issueNotificationAddress", () => {
  it.effect("is read for prod", () =>
    Effect.gen(function* read() {
      assert.deepStrictEqual(yield* readWith("prod"), Option.some("a@example.invalid"));
    }),
  );

  it.effect("is never read for test, staging and local stages", () =>
    Effect.gen(function* unread() {
      for (const stage of ["test-ci", "test-abc", "staging-1", "dev"] as const) {
        assert.isTrue(Option.isNone(yield* readWith(stage)));
        assert.isTrue(
          Option.isNone(
            yield* issueNotificationAddress(stage).pipe(
              Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
            ),
          ),
        );
      }
    }),
  );

  it.effect("fails naming the variable, the stage and the step when prod has no address", () =>
    Effect.gen(function* missing() {
      for (const stage of ["prod"] as const) {
        const failure = yield* Effect.flip(
          issueNotificationAddress(stage).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          ),
        );

        assert.strictEqual(failure._tag, "IssueNotificationEmailError");
        assert.include(failure.message, "ISSUE_NOTIFICATION_EMAIL");
        assert.include(failure.message, `stage ${stage}`);
        assert.include(failure.message, ISSUE_NOTIFICATION_STEP);
      }
    }),
  );
});

describe("issueNotificationAddress validation", () => {
  it.effect("fails at plan on a malformed address, naming the key and the step", () =>
    Effect.gen(function* malformed() {
      for (const bad of ["", "no-at-sign", "a@", "@b.invalid", "a b@c.invalid", "a@@b.invalid"]) {
        const failure = yield* Effect.flip(
          issueNotificationAddress("prod").pipe(
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ ISSUE_NOTIFICATION_EMAIL: bad })),
            ),
          ),
        );

        assert.strictEqual(failure._tag, "IssueNotificationEmailError");
        assert.include(failure.message, "ISSUE_NOTIFICATION_EMAIL");
        assert.include(failure.message, ISSUE_NOTIFICATION_STEP);
      }
    }),
  );
});
