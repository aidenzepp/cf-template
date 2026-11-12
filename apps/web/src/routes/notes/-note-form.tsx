import { useAtom } from "@effect/atom-react";
import { FieldError, FieldGroup } from "@workspace/ui/components/ui/field";
import { Cause, Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { SyntheticEvent } from "react";
import { NoteCreate, NotePatch } from "@workspace/contract/domain/note";
import type { Note } from "@workspace/contract/domain/note";
import { focusFirstInvalid, formValidator, useAppForm } from "../../components/form/form-hook.tsx";
import { notify } from "../../components/notify.ts";
import { NOTES_KEY, createNoteAtom, noteKey, updateNoteAtom } from "./-atoms.ts";
import { BodyField } from "./-body-field.tsx";

/**
 * The line shown for the result of the last save call.
 *
 * @param result - The create or update atom's value.
 * @returns The line, or `null` when the call did not fail.
 */
const failureLine = (
  result: AsyncResult.AsyncResult<unknown, { readonly _tag: string; readonly limit?: number }>,
) => {
  if (!AsyncResult.isFailure(result)) {
    return null;
  }

  const error = Cause.findErrorOption(result.cause);

  return Option.isSome(error) && error.value._tag === "NoteQuotaExceeded"
    ? `You have reached the limit of ${error.value.limit} notes.`
    : "The note could not be saved.";
};

/**
 * The submit handler of a form element: stops the page load and runs the form's own submit.
 *
 * @param submit - The form's `handleSubmit`.
 * @returns The handler.
 */
const submitWith = (submit: () => Promise<void>) => (event: SyntheticEvent<HTMLFormElement>) => {
  event.preventDefault();
  void submit();
};

/**
 * The form that creates a note. The fields validate against the contract's `NoteCreate`; a saved
 * note clears the form, raises a toast, and re-reads the list through the `notes` reactivity key.
 *
 * @returns The form.
 */
export const NoteForm = () => {
  const [result, create] = useAtom(createNoteAtom, { mode: "promiseExit" });

  const form = useAppForm({
    defaultValues: { body: "", title: "" },
    onSubmit: async ({ formApi, value }) => {
      const exit = await create({ payload: NoteCreate.make(value), reactivityKeys: [NOTES_KEY] });

      if (Exit.isSuccess(exit)) {
        formApi.reset();
        notify.success("Note created");
      }
    },
    onSubmitInvalid: focusFirstInvalid,
    validators: { onSubmit: formValidator(NoteCreate) },
  });

  return (
    <form
      noValidate
      onSubmit={submitWith(async () => {
        await form.handleSubmit();
      })}
    >
      <FieldGroup>
        <form.AppField name="title">{(field) => <field.TextField label="Title" />}</form.AppField>
        <form.AppField name="body">{(field) => <BodyField field={field} />}</form.AppField>
        <FieldError>{failureLine(result)}</FieldError>
        <form.AppForm>
          <form.SubmitButton>Create note</form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
};

/**
 * The form that edits a note. The fields validate against the contract's `NotePatch`; a saved note
 * raises a toast and re-reads the list and the note through their reactivity keys.
 *
 * @param props - The form's props.
 * @param props.note - The note being edited.
 * @returns The form.
 */
export const EditNoteForm = ({ note }: { readonly note: Note }) => {
  const [result, update] = useAtom(updateNoteAtom, { mode: "promiseExit" });

  const form = useAppForm({
    defaultValues: { body: note.body, title: note.title },
    onSubmit: async ({ value }) => {
      const exit = await update({
        params: { id: note.id },
        payload: NotePatch.make(value),
        reactivityKeys: [NOTES_KEY, noteKey(note.id)],
      });

      if (Exit.isSuccess(exit)) {
        notify.success("Note saved");
      }
    },
    onSubmitInvalid: focusFirstInvalid,
    validators: { onSubmit: formValidator(NotePatch) },
  });

  return (
    <form
      noValidate
      onSubmit={submitWith(async () => {
        await form.handleSubmit();
      })}
    >
      <FieldGroup>
        <form.AppField name="title">{(field) => <field.TextField label="Title" />}</form.AppField>
        <form.AppField name="body">{(field) => <BodyField field={field} />}</form.AppField>
        <FieldError>{failureLine(result)}</FieldError>
        <form.AppForm>
          <form.SubmitButton>Save note</form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
};
