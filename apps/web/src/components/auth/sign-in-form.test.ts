import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { submitForm } from "../form/submit-form.ts";
import { authOutcome } from "./auth-outcome.ts";
import { EMAIL_AUTOCOMPLETE, SignInInput, passkeyAutofill } from "./sign-in-form.tsx";

/**
 * Submits the sign-in form's data through the form pattern with a client call that answers
 * `error`, and records the calls and the redirects.
 */
const signIn = (
  fields: Record<string, string>,
  error: { readonly status: number; readonly code?: string } | null,
) => {
  const form = new FormData();
  const calls: Array<unknown> = [];
  const redirects: Array<true> = [];

  for (const [name, value] of Object.entries(fields)) {
    form.set(name, value);
  }

  return submitForm(SignInInput, ({ email, password }) =>
    authOutcome(
      () => {
        calls.push({ email, password });

        return Effect.runPromise(Effect.succeed({ error }));
      },
      () => {
        redirects.push(true);
      },
    ),
  )(form).pipe(Effect.map((outcome) => ({ calls, outcome, redirects })));
};

describe("sign-in form, end to end", () => {
  it.effect("shows a line for each empty field and makes no call", () =>
    Effect.gen(function* empty() {
      const { calls, outcome } = yield* signIn({ email: "", password: "" }, null);

      expect(outcome).toStrictEqual({
        _tag: "Invalid",
        errors: { email: "Enter your email.", password: "Enter your password." },
      });
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("calls the client once with the decoded fields and opens the next screen", () =>
    Effect.gen(function* valid() {
      const { calls, outcome, redirects } = yield* signIn(
        { email: "ada@example.com", password: "secret" },
        null,
      );

      expect(outcome).toStrictEqual({ _tag: "Saved", title: undefined });
      expect(calls).toStrictEqual([{ email: "ada@example.com", password: "secret" }]);
      expect(redirects).toHaveLength(1);
    }),
  );

  it.effect("fails with the line for the server's answer and stays on the form", () =>
    Effect.gen(function* refused() {
      const { outcome, redirects } = yield* signIn(
        { email: "ada@example.com", password: "wrong" },
        { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 },
      );

      expect(outcome).toStrictEqual({ _tag: "Failed", message: "Wrong email or password." });
      expect(redirects).toHaveLength(0);
    }),
  );
});

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
