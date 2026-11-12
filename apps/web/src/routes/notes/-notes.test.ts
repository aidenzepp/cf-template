import { expect, it } from "@effect/vitest";
import { FormApi } from "@tanstack/react-form";
import { Cause, Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
  NOTE_BODY_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
  NoteCreate,
  NoteId,
  NotePatch,
} from "@workspace/contract/domain/note";
import { NoteNotFound, NotesUnavailable } from "@workspace/contract/domain/note-errors";
import { focusFirstInvalid, formValidator } from "../../components/form/form-hook.tsx";
import { noteFailureOf } from "./-note-failure.ts";

/**
 * The lines a contract schema's validator gives each field of `values`, keyed by field name.
 */
const linesOf = (
  validator: ReturnType<typeof formValidator>,
  values: Readonly<Record<string, string>>,
) =>
  Effect.promise(async () => {
    const result = await validator["~standard"].validate(values);

    return "issues" in result && result.issues !== undefined
      ? result.issues.map(({ message, path }) => [path, message])
      : [];
  });

it.effect("accepts a filled note and a note at the caps", () =>
  Effect.gen(function* filled() {
    const atCaps = {
      body: "b".repeat(NOTE_BODY_MAX_LENGTH),
      title: "t".repeat(NOTE_TITLE_MAX_LENGTH),
    };

    expect(
      yield* linesOf(formValidator(NoteCreate), { body: "milk", title: "Shopping" }),
    ).toStrictEqual([]);
    expect(yield* linesOf(formValidator(NoteCreate), atCaps)).toStrictEqual([]);
    expect(yield* linesOf(formValidator(NotePatch), atCaps)).toStrictEqual([]);
  }),
);

it.effect("gives an over-long title or body the contract's own line", () =>
  Effect.gen(function* tooLong() {
    const values = {
      body: "b".repeat(NOTE_BODY_MAX_LENGTH + 1),
      title: "t".repeat(NOTE_TITLE_MAX_LENGTH + 1),
    };

    const lines = [
      [["body"], `The body is too long: use at most ${NOTE_BODY_MAX_LENGTH} characters.`],
      [["title"], `The title is too long: use at most ${NOTE_TITLE_MAX_LENGTH} characters.`],
    ];

    expect(yield* linesOf(formValidator(NoteCreate), values)).toStrictEqual(lines);
    expect(yield* linesOf(formValidator(NotePatch), values)).toStrictEqual(lines);
  }),
);

it.effect("asks for a title when it is empty or blank, on create and on edit", () =>
  Effect.gen(function* blank() {
    for (const title of ["", "   "]) {
      const lines = [[["title"], "Enter a title."]];

      expect(yield* linesOf(formValidator(NoteCreate), { body: "milk", title })).toStrictEqual(
        lines,
      );

      expect(yield* linesOf(formValidator(NotePatch), { body: "milk", title })).toStrictEqual(
        lines,
      );
    }
  }),
);

it.effect("shows the title line and focuses the title when an empty title is submitted", () =>
  Effect.gen(function* submitBlank() {
    const focused: Array<string> = [];

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        Reflect.set(globalThis, "document", {
          querySelector: (selector: string) => ({ focus: () => focused.push(selector) }),
        }),
      ),
      () => Effect.sync(() => Reflect.deleteProperty(globalThis, "document")),
    );

    const form = new FormApi({
      defaultValues: { body: "milk", title: "" },
      onSubmitInvalid: focusFirstInvalid,
      validators: { onSubmit: formValidator(NoteCreate) },
    });

    form.mount();
    yield* Effect.promise(() => form.handleSubmit());

    const errors: unknown = form.state.fieldMeta.title?.errors;

    expect(errors).toMatchObject([{ message: "Enter a title." }]);
    expect(focused).toStrictEqual(["#title"]);
  }).pipe(Effect.scoped),
);

it.effect("asks to fill in a field the values do not hold", () =>
  Effect.gen(function* missing() {
    expect(yield* linesOf(formValidator(NoteCreate), { title: "Shopping" })).toStrictEqual([
      [["body"], "Fill in this field."],
    ]);
  }),
);

it("tells NoteNotFound and NotesUnavailable apart by tag", () => {
  const missing = AsyncResult.failure(Cause.fail(new NoteNotFound({ id: NoteId.make("n1") })));
  const off = AsyncResult.failure(Cause.fail(new NotesUnavailable()));

  expect(noteFailureOf(missing)).toBe("missing");
  expect(noteFailureOf(off)).toBe("unavailable");
  expect(noteFailureOf(AsyncResult.success("ok"))).toBeUndefined();
});
