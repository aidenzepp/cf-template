import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { signOutFailure, signOutFlow, signOutOutcome } from "./sign-out.ts";

describe("signOutOutcome", () => {
  it.effect("reports signedOut when the response carries no error", () =>
    Effect.gen(function* succeeds() {
      const outcome = yield* signOutOutcome(() => Promise.resolve({ error: null }));

      expect(outcome).toBe("signedOut");
    }),
  );

  it.effect("reports failed when the response carries an error", () =>
    Effect.gen(function* refused() {
      const outcome = yield* signOutOutcome(() =>
        Promise.resolve({ error: { status: 500, statusText: "Internal Server Error" } }),
      );

      expect(outcome).toBe("failed");
    }),
  );

  it.effect("reports failed when the call rejects", () =>
    Effect.gen(function* rejects() {
      const outcome = yield* signOutOutcome(() => Promise.reject(new Error("offline")));

      expect(outcome).toBe("failed");
    }),
  );
});

/**
 * Runs the flow over a call that answers `error`, and returns which continuations ran.
 */
const eventsOf = (refusal: null | { readonly status: number }) => {
  const answer = Promise.resolve({ error: refusal });

  return Effect.gen(function* record() {
    const events: Array<string> = [];

    yield* signOutFlow({
      call: () => answer,
      fail: () => {
        events.push("fail");
      },
      leave: () => {
        events.push("leave");

        return Promise.resolve();
      },
    });

    return events;
  });
};

describe("signOutFlow", () => {
  it.effect("leaves and never fails after a successful sign-out", () =>
    Effect.gen(function* leaves() {
      expect(yield* eventsOf(null)).toStrictEqual(["leave"]);
    }),
  );

  it.effect("fails and stays when the call is refused", () =>
    Effect.gen(function* stays() {
      expect(yield* eventsOf({ status: 500 })).toStrictEqual(["fail"]);
    }),
  );
});

describe("signOutFailure", () => {
  it("names what failed, that the session remains and the next step", () => {
    expect(signOutFailure.title).toBe("Could not sign out");
    expect(signOutFailure.description).toContain("still signed in");
    expect(signOutFailure.description).toContain("select Sign out again");
  });
});
