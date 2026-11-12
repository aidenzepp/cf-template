import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { decodeForm } from "./decode-form.ts";
import { emailField, required } from "./fields.ts";

const Input = Schema.Struct({
  email: emailField,
  name: required("Enter your name."),
  note: Schema.String.check(Schema.isMaxLength(3)),
});

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    form.set(name, value);
  }

  return form;
};

const errorsOf = (fields: Record<string, string>) => Effect.flip(decodeForm(Input)(formOf(fields)));

describe("decode form to field errors", () => {
  it.effect("decodes a valid form to the schema's value", () =>
    Effect.gen(function* valid() {
      const values = yield* decodeForm(Input)(
        formOf({ email: "ada@example.com", name: "Ada", note: "hi" }),
      );

      expect(values).toStrictEqual({ email: "ada@example.com", name: "Ada", note: "hi" });
    }),
  );

  it.effect("gives each invalid field the line its check names", () =>
    Effect.gen(function* lines() {
      const errors = yield* errorsOf({ email: "ada", name: "", note: "hi" });

      expect(errors).toStrictEqual({
        email: "Enter an email like ada@example.com.",
        name: "Enter your name.",
      });
    }),
  );

  it.effect("asks to fill in a field the form does not hold", () =>
    Effect.gen(function* missing() {
      const errors = yield* errorsOf({ email: "ada@example.com" });

      expect(errors).toStrictEqual({ name: "Fill in this field.", note: "Fill in this field." });
    }),
  );

  it.effect("falls back to a generic line for a check with no line of its own", () =>
    Effect.gen(function* generic() {
      const errors = yield* errorsOf({ email: "ada@example.com", name: "Ada", note: "toolong" });

      expect(errors).toStrictEqual({ note: "Check this field." });
    }),
  );

  it.effect("keeps the first line of a field that fails more than one check", () =>
    Effect.gen(function* first() {
      const errors = yield* errorsOf({ email: "", name: "Ada", note: "hi" });

      expect(errors).toStrictEqual({ email: "Enter your email." });
    }),
  );
});
