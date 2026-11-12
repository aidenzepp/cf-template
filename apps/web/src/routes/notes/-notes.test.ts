import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { NoteNotFound, NotesUnavailable } from "@workspace/contract/domain/note-errors";
import { NoteCreate, NoteId, NotePatch } from "@workspace/contract/domain/note";
import { noteFailureOf } from "./-note-failure.ts";
import { NoteInput, noteCreateOf, notePatchOf } from "./-note-input.ts";
import { saveNote } from "./-note-save.ts";
import { submitForm } from "../../components/form/submit-form.ts";

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    form.set(name, value);
  }

  return form;
};

/**
 * Submits a form to the note form's schema with a save call that answers `exit`, recording how
 * often the call ran and what it received.
 */
const submitNote = (fields: Record<string, string>, exit: Exit.Exit<unknown, NoteError>) => {
  const received: Array<unknown> = [];
  const refreshed: Array<true> = [];

  return submitForm(NoteInput, (payload) =>
    saveNote(
      () => {
        received.push(payload);

        return Effect.runPromise(Effect.succeed(exit));
      },
      "Note created.",
      () => {
        refreshed.push(true);
      },
    ),
  )(formOf(fields)).pipe(Effect.map((outcome) => ({ outcome, received, refreshed })));
};

interface NoteError {
  readonly _tag: string;
  readonly limit?: number;
}

it.effect("decodes a filled form as the contract's create and update request", () =>
  Effect.gen(function* decodes() {
    const { outcome, received, refreshed } = yield* submitNote(
      { body: "milk", title: "Shopping" },
      Exit.void,
    );

    expect(outcome).toStrictEqual({ _tag: "Saved", title: "Note created." });
    expect(refreshed).toHaveLength(1);
    expect(Schema.decodeUnknownSync(NoteCreate)(received[0])).toMatchObject({ title: "Shopping" });
    expect(Schema.decodeUnknownSync(NotePatch)(received[0])).toMatchObject({ body: "milk" });
  }),
);

it.effect("shows each invalid field's line and makes no call", () =>
  Effect.gen(function* invalid() {
    const missing = yield* submitNote({ body: "milk" }, Exit.void);
    const empty = yield* submitNote({ body: "", title: "" }, Exit.void);
    const long = yield* submitNote({ body: "x".repeat(10_001), title: "t" }, Exit.void);

    expect(missing.outcome).toStrictEqual({
      _tag: "Invalid",
      errors: { title: "Fill in this field." },
    });
    expect(empty.outcome).toStrictEqual({ _tag: "Invalid", errors: { title: "Enter a title." } });
    expect(long.outcome).toStrictEqual({
      _tag: "Invalid",
      errors: { body: "Use at most 10000 characters." },
    });
    expect([missing, empty, long].flatMap(({ received }) => received)).toHaveLength(0);
  }),
);

it.effect("reports the quota refusal and any other failure as the form's line", () =>
  Effect.gen(function* failures() {
    const quota = yield* submitNote(
      { body: "", title: "t" },
      Exit.fail({ _tag: "NoteQuotaExceeded", limit: 50 }),
    );

    const other = yield* submitNote(
      { body: "", title: "t" },
      Exit.fail({ _tag: "NotesUnavailable" }),
    );

    expect(quota.outcome).toStrictEqual({
      _tag: "Failed",
      message: "You have reached the limit of 50 notes.",
    });
    expect(other.outcome).toStrictEqual({
      _tag: "Failed",
      message: "The note could not be saved.",
    });
    expect(quota.refreshed).toHaveLength(0);
  }),
);

it("builds the contract's request classes, which the API client encodes; a plain object it refuses", () => {
  const input = { body: "milk", title: "Shopping" };

  expect(Schema.encodeUnknownSync(NoteCreate)(noteCreateOf(input))).toStrictEqual(input);
  expect(Schema.encodeUnknownSync(NotePatch)(notePatchOf(input))).toStrictEqual(input);
  expect(Exit.isFailure(Schema.encodeUnknownExit(NoteCreate)(input))).toBeTruthy();
});

it("tells NoteNotFound and NotesUnavailable apart by tag", () => {
  const missing = AsyncResult.failure(Cause.fail(new NoteNotFound({ id: NoteId.make("n1") })));
  const off = AsyncResult.failure(Cause.fail(new NotesUnavailable()));

  expect(noteFailureOf(missing)).toBe("missing");
  expect(noteFailureOf(off)).toBe("unavailable");
  expect(noteFailureOf(AsyncResult.success("ok"))).toBeUndefined();
});
