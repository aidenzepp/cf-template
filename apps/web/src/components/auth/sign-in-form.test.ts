import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { submitForm } from "../form/submit-form.ts";
import { authOutcome } from "./auth-outcome.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EMAIL_AUTOCOMPLETE, LastUsed, SignInInput, passkeyAutofill } from "./sign-in-form.tsx";

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

const run = (
  available: boolean | undefined,
  controller = new AbortController(),
  error: { readonly status: number } | null = null,
) =>
  Effect.gen(function* started() {
    const calls: Array<AbortSignal> = [];
    const saved: Array<true> = [];

    yield* passkeyAutofill(
      ({ autoFill, fetchOptions }) => {
        expect(autoFill).toBeTruthy();
        calls.push(fetchOptions.signal);

        return Promise.resolve({ error });
      },
      available === undefined
        ? undefined
        : { isConditionalMediationAvailable: () => Promise.resolve(available) },
      controller.signal,
      () => {
        saved.push(true);
      },
    );

    return { calls, saved };
  });

describe("sign-in passkey autofill", () => {
  it("marks the email input for passkey autofill", () => {
    expect(EMAIL_AUTOCOMPLETE).toBe("username webauthn");
  });

  it.effect("does not call signIn.passkey without conditional mediation", () =>
    Effect.gen(function* absent() {
      expect((yield* run(undefined)).calls).toHaveLength(0);
      expect((yield* run(false)).calls).toHaveLength(0);
    }),
  );

  it.effect("calls signIn.passkey once with the abort signal, and unmount aborts it", () =>
    Effect.gen(function* present() {
      const controller = new AbortController();
      const { calls } = yield* run(true, controller);

      expect(calls).toStrictEqual([controller.signal]);
      expect(controller.signal.aborted).toBeFalsy();

      controller.abort();

      expect(calls[0]?.aborted).toBeTruthy();
    }),
  );

  it.effect("runs onSaved after a successful sign-in and not after a failed one", () =>
    Effect.gen(function* outcome() {
      expect((yield* run(true)).saved).toHaveLength(1);
      expect((yield* run(true, new AbortController(), { status: 400 })).saved).toHaveLength(0);
      expect((yield* run(false)).saved).toHaveLength(0);
    }),
  );

  it.effect("does not start once the form has already unmounted", () =>
    Effect.gen(function* unmounted() {
      const controller = new AbortController();

      controller.abort();

      expect((yield* run(true, controller)).calls).toHaveLength(0);
    }),
  );
});

describe("sign-in last-used badge", () => {
  it("shows the tag on the last-used method", () => {
    expect(renderToStaticMarkup(createElement(LastUsed, { shown: true }))).toBe(
      '<span data-badge="true">Last used</span>',
    );
  });

  it("shows nothing when there is no record or another method was used", () => {
    expect(renderToStaticMarkup(createElement(LastUsed, { shown: false }))).toBe("");
  });
});
