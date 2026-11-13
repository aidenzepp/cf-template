import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@effect/vitest";
import { NotesModel } from "./notes.model.ts";
import { createsANote, deletesANote, refusesPastTheLimit, updatesANote } from "./notes.story.ts";

describe("the notes model", () => {
  it("is well defined", () => {
    expect(Domain.verify(NotesModel)).toStrictEqual([]);
  });

  it.effect("creates a note and refuses a duplicate id", () => createsANote);
  it.effect("refuses a create past the per-owner limit", () => refusesPastTheLimit);
  it.effect("updates a note and refuses an unknown one", () => updatesANote);
  it.effect("deletes a note and refuses a second delete", () => deletesANote);
});
