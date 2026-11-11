import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { NOTE_BODY_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH, NoteCreate, NotePatch } from "./note.ts";

describe("note size caps", () => {
  const decodeCreate = Schema.decodeUnknownExit(NoteCreate);
  const decodePatch = Schema.decodeUnknownExit(NotePatch);

  it("accepts a title and body at their caps", () => {
    const body = "b".repeat(NOTE_BODY_MAX_LENGTH);
    const title = "t".repeat(NOTE_TITLE_MAX_LENGTH);

    assert.isTrue(decodeCreate({ body, title })._tag === "Success");
    assert.isTrue(decodePatch({ body, title })._tag === "Success");
  });

  it("refuses a title or body one character over", () => {
    const body = "b".repeat(NOTE_BODY_MAX_LENGTH + 1);
    const title = "t".repeat(NOTE_TITLE_MAX_LENGTH + 1);

    assert.isTrue(decodeCreate({ body: "", title })._tag === "Failure");
    assert.isTrue(decodeCreate({ body, title: "t" })._tag === "Failure");
    assert.isTrue(decodePatch({ title })._tag === "Failure");
    assert.isTrue(decodePatch({ body })._tag === "Failure");
  });
});
