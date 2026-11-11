import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { EMAIL_AUTOCOMPLETE, passkeyAutofill } from "./sign-in-form.tsx";

const run = (available: boolean | undefined, controller = new AbortController()) =>
  Effect.gen(function* started() {
    const calls: Array<AbortSignal> = [];

    yield* passkeyAutofill(
      ({ autoFill, fetchOptions }) => {
        expect(autoFill).toBeTruthy();
        calls.push(fetchOptions.signal);

        return Promise.resolve(calls.length);
      },
      available === undefined
        ? undefined
        : { isConditionalMediationAvailable: () => Promise.resolve(available) },
      controller.signal,
    );

    return calls;
  });

describe("sign-in passkey autofill", () => {
  it("marks the email input for passkey autofill", () => {
    expect(EMAIL_AUTOCOMPLETE).toBe("username webauthn");
  });

  it.effect("does not call signIn.passkey without conditional mediation", () =>
    Effect.gen(function* absent() {
      expect(yield* run(undefined)).toHaveLength(0);
      expect(yield* run(false)).toHaveLength(0);
    }),
  );

  it.effect("calls signIn.passkey once with the abort signal, and unmount aborts it", () =>
    Effect.gen(function* present() {
      const controller = new AbortController();
      const calls = yield* run(true, controller);

      expect(calls).toStrictEqual([controller.signal]);
      expect(controller.signal.aborted).toBeFalsy();

      controller.abort();

      expect(calls[0]?.aborted).toBeTruthy();
    }),
  );

  it.effect("does not start once the form has already unmounted", () =>
    Effect.gen(function* unmounted() {
      const controller = new AbortController();

      controller.abort();

      expect(yield* run(true, controller)).toHaveLength(0);
    }),
  );
});
