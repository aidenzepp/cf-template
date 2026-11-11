import { expect, it } from "@effect/vitest";
import { Option } from "effect";
import { readNoteCreate } from "./-note-input.ts";

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    form.set(name, value);
  }

  return form;
};

it("decodes a filled form into the contract's create request", () => {
  const payload = readNoteCreate(formOf({ body: "milk", title: "Shopping" }));

  expect(Option.getOrUndefined(payload)).toMatchObject({ body: "milk", title: "Shopping" });
});

it("rejects a form with a missing field", () => {
  expect(Option.isNone(readNoteCreate(formOf({ title: "Shopping" })))).toBe(true);
});
