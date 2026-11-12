import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { signOutFailure, signOutFlow } from "./sign-out.ts";

/**
 * Runs the flow over a call that answers `answer`, and returns which continuations ran.
 */
const eventsOf = (answer: () => Promise<{ readonly error: null | { readonly status: number } }>) =>
  Effect.gen(function* record() {
    const events: Array<string> = [];

    yield* signOutFlow({
      call: answer,
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

describe("signOutFlow", () => {
  it.effect("leaves and never fails after a successful sign-out", () =>
    Effect.gen(function* leaves() {
      expect(yield* eventsOf(() => Promise.resolve({ error: null }))).toStrictEqual(["leave"]);
    }),
  );

  it.effect("fails and stays when the call is refused", () =>
    Effect.gen(function* stays() {
      expect(yield* eventsOf(() => Promise.resolve({ error: { status: 500 } }))).toStrictEqual([
        "fail",
      ]);
    }),
  );

  it.effect("fails and stays when the call rejects", () =>
    Effect.gen(function* rejects() {
      expect(yield* eventsOf(() => Promise.reject(new Error("offline")))).toStrictEqual(["fail"]);
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
