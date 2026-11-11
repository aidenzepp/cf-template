import { expect, it } from "@effect/vitest";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { NoteNotFound, NotesUnavailable } from "@workspace/contract/domain/note-errors";
import { NoteId } from "@workspace/contract/domain/note";
import { noteFailureOf } from "./-note-failure.ts";
import { readNoteCreate, readNotePatch } from "./-note-input.ts";

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

it("decodes a filled form into the contract's update request", () => {
  const payload = readNotePatch(formOf({ body: "oat milk", title: "Shopping" }));

  expect(Option.getOrUndefined(payload)).toMatchObject({ body: "oat milk", title: "Shopping" });
});

it("tells NoteNotFound and NotesUnavailable apart by tag", () => {
  const missing = AsyncResult.failure(Cause.fail(new NoteNotFound({ id: NoteId.make("n1") })));
  const off = AsyncResult.failure(Cause.fail(new NotesUnavailable()));

  expect(noteFailureOf(missing)).toBe("missing");
  expect(noteFailureOf(off)).toBe("unavailable");
  expect(noteFailureOf(AsyncResult.success("ok"))).toBeUndefined();
});
