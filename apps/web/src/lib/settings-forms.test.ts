import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { settingsOutcome } from "../components/auth/auth-outcome.ts";
import { submitForm } from "../components/form/submit-form.ts";
import { FRESH_SESSION_CODE } from "./settings-calls.ts";
import { PasswordInput, ProfileInput } from "./settings-forms.ts";

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    form.set(name, value);
  }

  return form;
};

/**
 * Submits a profile form through the form pattern with a client call that answers `error`,
 * recording what the call received and how often the list was reloaded.
 */
const saveProfile = (
  fields: Record<string, string>,
  error: { readonly status: number; readonly code?: string } | null,
) => {
  const calls: Array<unknown> = [];
  const reloads: Array<true> = [];

  return submitForm(ProfileInput, ({ image, name }) =>
    settingsOutcome(
      () => {
        calls.push({ image, name });

        return Effect.runPromise(Effect.succeed({ error }));
      },
      "Profile saved.",
      () => {
        reloads.push(true);
      },
    ),
  )(formOf(fields)).pipe(Effect.map((outcome) => ({ calls, outcome, reloads })));
};

/**
 * Submits a password form and echoes the decoded value back as the failure line, to show what the
 * schema hands the call.
 */
const read = (fields: Record<string, string>) =>
  submitForm(PasswordInput, (values) =>
    Effect.succeed({ _tag: "Failed" as const, message: JSON.stringify(values) }),
  )(formOf(fields));

describe("settings forms, end to end", () => {
  it.effect("shows each invalid field's line and makes no call", () =>
    Effect.gen(function* invalid() {
      const { calls, outcome } = yield* saveProfile({ image: "ftp://x", name: "" }, null);

      expect(outcome).toStrictEqual({
        _tag: "Invalid",
        errors: { image: "Enter a link that starts with https://.", name: "Enter your name." },
      });
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("makes one call with the decoded fields and raises the success title", () =>
    Effect.gen(function* valid() {
      const { calls, outcome, reloads } = yield* saveProfile({ image: "", name: "Ada" }, null);

      expect(outcome).toStrictEqual({ _tag: "Saved", title: "Profile saved." });
      expect(calls).toStrictEqual([{ image: "", name: "Ada" }]);
      expect(reloads).toHaveLength(1);
    }),
  );

  it.effect("pauses on the stale-session refusal without reloading, so the prompt can retry", () =>
    Effect.gen(function* stale() {
      const { outcome, reloads } = yield* saveProfile(
        { image: "", name: "Ada" },
        { code: FRESH_SESSION_CODE, status: 403 },
      );

      expect(outcome).toStrictEqual({ _tag: "Paused" });
      expect(reloads).toHaveLength(0);
    }),
  );

  it.effect("fails with the line for the server's answer and still reloads", () =>
    Effect.gen(function* refused() {
      const { outcome, reloads } = yield* saveProfile(
        { image: "", name: "Ada" },
        { code: "INVALID_PASSWORD", status: 400 },
      );

      expect(outcome).toStrictEqual({ _tag: "Failed", message: "That password is wrong." });
      expect(reloads).toHaveLength(1);
    }),
  );

  it.effect("reads the unchecked sign-out box as no `revoke` field", () =>
    Effect.gen(function* password() {
      expect(yield* read({ current: "a", next: "b" })).toStrictEqual({
        _tag: "Failed",
        message: '{"current":"a","next":"b"}',
      });
      expect(yield* read({ current: "a", next: "b", revoke: "on" })).toStrictEqual({
        _tag: "Failed",
        message: '{"current":"a","next":"b","revoke":"on"}',
      });
      expect(yield* read({ current: "", next: "b" })).toStrictEqual({
        _tag: "Invalid",
        errors: { current: "Enter your current password." },
      });
    }),
  );
});
