import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import { Stages, Workers, workerName } from "../stages.ts";
import type { StageName } from "../stages.ts";
import {
  ISSUE_NOTIFICATION_STEP,
  PROJECTION_FAILURE_THRESHOLD,
  ProjectionConsumers,
  issueNotificationAddress,
  projectionFailureQuery,
  rateLimitErrorQuery,
  volumeAlertQuery,
  volumeAlertThreshold,
  volumeAlertWorkers,
} from "./alerts.ts";

describe("volumeAlertThreshold", () => {
  it("is 3472 at the default share and fraction", () => {
    assert.strictEqual(volumeAlertThreshold(0.5, 0.5), 3472);
  });

  it("is a positive integer for every share and fraction in (0, 1]", () => {
    const steps = [0.01, 0.1, 0.25, 0.5, 0.75, 1];

    for (const share of steps) {
      for (const fraction of steps) {
        const threshold = volumeAlertThreshold(share, fraction);

        assert.isTrue(Number.isInteger(threshold) && threshold > 0);
      }
    }
  });
});

describe("volumeAlertWorkers", () => {
  it.effect("lists each Worker in order, without the shared state store", () =>
    Effect.gen(function* lists() {
      const names = yield* volumeAlertWorkers("s", "test-abc");

      assert.deepStrictEqual(names, ["s-web-test-abc", "s-api-test-abc", "s-auth-test-abc"]);
      assert.strictEqual(names.length, Workers.length);
    }),
  );
});

describe("volumeAlertQuery", () => {
  it.effect("scopes to the account and names every Worker of volumeAlertWorkers", () =>
    Effect.gen(function* names() {
      const workers = yield* volumeAlertWorkers("s", "test-abc");
      const query = volumeAlertQuery("acct", workers);

      assert.include(query, "accountTag = 'acct'");
      assert.include(query, "FROM logs.workersLogs");

      for (const worker of workers) {
        assert.include(query, `'${worker}'`);
      }
    }),
  );
});

describe("rateLimitErrorQuery", () => {
  it.effect("scopes to the account, names web's script and matches the event", () =>
    Effect.gen(function* names() {
      const script = yield* workerName({ stack: "s", stage: "test-abc", worker: "web" });
      const query = rateLimitErrorQuery("acct", script);

      assert.include(query, "accountTag = 'acct'");
      assert.include(query, `scriptName = '${script}'`);
      assert.include(query, "attributes['message'] = 'web.ratelimit.error'");
      assert.notInclude(query, "JSONExtract");
      assert.notInclude(query, "-api-");
    }),
  );
});

describe("projectionFailureQuery", () => {
  it.effect("scopes to the account and api's script and matches each consumer's failed runs", () =>
    Effect.gen(function* consumers() {
      const script = yield* workerName({ stack: "s", stage: "test-abc", worker: "api" });

      for (const consumer of ProjectionConsumers) {
        const query = projectionFailureQuery("acct", script, consumer);

        assert.include(query, "FROM logs.workersLogs");
        assert.include(query, "accountTag = 'acct'");
        assert.include(query, `scriptName = '${script}'`);
        assert.include(query, "attributes['event'] = 'domain.run.failed'");
        assert.include(query, `attributes['consumer'] = '${consumer}'`);
        assert.notInclude(query, "JSONExtract");
      }
    }),
  );

  it("watches the note index and fires above two failed runs", () => {
    assert.deepStrictEqual([...ProjectionConsumers], ["NoteIndex"]);
    assert.strictEqual(PROJECTION_FAILURE_THRESHOLD, 2);
  });
});

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

describe("volumeAlert flag", () => {
  it("is on for prod only", () => {
    assert.isTrue(Stages.prod.volumeAlert);
    assert.isFalse(Stages.test.volumeAlert);
    assert.isFalse(Stages.staging.volumeAlert);
    assert.isFalse(Stages.local.volumeAlert);
  });
});
