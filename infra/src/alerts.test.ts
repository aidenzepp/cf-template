import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import { Stages, Workers } from "../stages.ts";
import type { StageName } from "../stages.ts";
import {
  headSamplingRate,
  issuesObservability,
  telemetryOptions,
  webObservability,
} from "./telemetry.ts";
import {
  issueNotificationAddress,
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
  it.effect("lists each Worker in order, then the state store", () =>
    Effect.gen(function* lists() {
      const names = yield* volumeAlertWorkers("s", "test-abc");

      assert.deepStrictEqual(names, [
        "s-web-test-abc",
        "s-api-test-abc",
        "s-auth-test-abc",
        "s-state",
      ]);
      assert.strictEqual(names.length, Workers.length + 1);
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
  it.effect("is read for prod and test stages", () =>
    Effect.gen(function* read() {
      for (const stage of ["prod", "test-ci", "test-abc"] as const) {
        assert.deepStrictEqual(yield* readWith(stage), Option.some("a@example.invalid"));
      }
    }),
  );

  it.effect("is never read for staging and local stages", () =>
    Effect.gen(function* unread() {
      for (const stage of ["staging-1", "dev"] as const) {
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

  it.effect("fails when a stage that needs it has no address", () =>
    Effect.gen(function* missing() {
      const failure = yield* Effect.flip(
        issueNotificationAddress("prod").pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        ),
      );

      assert.strictEqual(failure._tag, "ConfigError");
    }),
  );
});

describe("issueNotificationAddress validation", () => {
  it.effect("fails at plan on a malformed address, naming the key", () =>
    Effect.gen(function* malformed() {
      for (const bad of ["", "no-at-sign", "a@", "@b.invalid", "a b@c.invalid", "a@@b.invalid"]) {
        const failure = yield* Effect.flip(
          issueNotificationAddress("prod").pipe(
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ ISSUE_NOTIFICATION_EMAIL: bad })),
            ),
          ),
        );

        assert.strictEqual(failure._tag, "ConfigError");
        assert.include(failure.message, "ISSUE_NOTIFICATION_EMAIL");
      }
    }),
  );
});

describe("volumeAlert flag", () => {
  it("is on for prod and test and off for staging and local", () => {
    assert.isTrue(Stages.prod.volumeAlert);
    assert.isTrue(Stages.test.volumeAlert);
    assert.isFalse(Stages.staging.volumeAlert);
    assert.isFalse(Stages.local.volumeAlert);
  });
});

describe("telemetry", () => {
  it("samples every request in every stage kind", () => {
    for (const stage of ["prod", "staging-1", "test-ci", "dev"] as const) {
      assert.strictEqual(headSamplingRate(stage), 1);
      assert.deepStrictEqual(telemetryOptions(stage), { headSamplingRate: 1 });
    }
  });

  it("keeps the default logs and turns Issues on for all three Workers", () => {
    const web = webObservability("prod");

    assert.deepStrictEqual(web.traces, { enabled: true, headSamplingRate: 1 });

    for (const observability of [web, issuesObservability]) {
      assert.isTrue(observability.issues.enabled);
      assert.deepStrictEqual(observability.logs, { enabled: true, invocationLogs: true });
    }
  });
});
