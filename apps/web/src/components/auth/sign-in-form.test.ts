import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { formValidator } from "../form/form-hook.tsx";
import { EMAIL_AUTOCOMPLETE, SignInInput, passkeyAutofill } from "./sign-in-form.tsx";

/**
 * The lines the sign-in validator gives each field of `values`, keyed by field name.
 */
const linesOf = (values: Partial<typeof SignInInput.Encoded>) =>
  Effect.promise(async () => {
    const result = await formValidator(SignInInput)["~standard"].validate(values);

    return "issues" in result && result.issues !== undefined
      ? result.issues.map(({ message, path }) => [path, message])
      : [];
  });

describe("sign-in validator", () => {
  it.effect("gives each empty field one line", () =>
    Effect.gen(function* empty() {
      expect(yield* linesOf({ email: "", password: "" })).toStrictEqual([
        [["email"], "Enter an email like ada@example.com."],
        [["password"], "Enter your password."],
      ]);
    }),
  );

  it.effect("asks for an address that looks like one", () =>
    Effect.gen(function* address() {
      expect(yield* linesOf({ email: "ada", password: "secret" })).toStrictEqual([
        [["email"], "Enter an email like ada@example.com."],
      ]);
    }),
  );

  it.effect("asks to fill in a field the values do not hold, and accepts a valid pair", () =>
    Effect.gen(function* rest() {
      expect(yield* linesOf({ email: "ada@example.com" })).toStrictEqual([
        [["password"], "Fill in this field."],
      ]);
      expect(yield* linesOf({ email: "ada@example.com", password: "secret" })).toStrictEqual([]);
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
