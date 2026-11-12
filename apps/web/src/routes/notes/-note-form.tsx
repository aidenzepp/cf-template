import { useAtomRefresh, useAtomSet } from "@effect/atom-react";
import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { Textarea } from "@workspace/ui/components/ui/textarea";
import type { Note } from "@workspace/contract/domain/note";
import { useForm } from "../../components/form/use-form.ts";
import { fork } from "../../runtime.ts";
import { createNoteAtom, noteAtom, notesListAtom, updateNoteAtom } from "./-atoms.ts";
import { NoteInput, noteCreateOf, notePatchOf } from "./-note-input.ts";
import { saveNote } from "./-note-save.ts";

/**
 * The fields and the submit button shared by both modes.
 *
 * @param props - The fields' props.
 * @param props.form - The form hook's state for this form.
 * @param props.note - The note being edited; absent when creating.
 * @returns The fields.
 */
const NoteFields = ({
  form: { error, failure, field, pending },
  note,
}: {
  readonly form: Pick<ReturnType<typeof useForm>, "error" | "failure" | "field" | "pending">;
  readonly note?: Note;
}) => (
  <FieldGroup>
    <Field>
      <FieldLabel htmlFor="title">Title</FieldLabel>
      <Input
        defaultValue={note?.title}
        id="title"
        name="title"
        required
        type="text"
        {...field("title")}
      />
      <FieldError {...error("title")} />
    </Field>
    <Field>
      <FieldLabel htmlFor="body">Body</FieldLabel>
      <Textarea defaultValue={note?.body} id="body" name="body" {...field("body")} />
      <FieldError {...error("body")} />
    </Field>
    <FieldError>{failure}</FieldError>
    <Button disabled={pending} type="submit">
      {note === undefined ? "Create note" : "Save note"}
    </Button>
  </FieldGroup>
);

/**
 * The form that creates a note. After a successful call the list re-reads from the server once and
 * the form clears.
 *
 * @returns The form.
 */
export const NoteForm = () => {
  const create = useAtomSet(createNoteAtom, { mode: "promiseExit" });
  const refreshList = useAtomRefresh(notesListAtom);

  const form = useForm(
    NoteInput,
    (payload) =>
      saveNote(() => create({ payload: noteCreateOf(payload) }), "Note created.", refreshList),
    { fork, resetOnSaved: true },
  );

  return (
    <form {...form.formProps}>
      <NoteFields form={form} />
    </form>
  );
};

/**
 * The form that edits a note. After a successful call the list and the note re-read from the server
 * once.
 *
 * @param props - The form's props.
 * @param props.note - The note being edited.
 * @returns The form.
 */
export const EditNoteForm = ({ note }: { readonly note: Note }) => {
  const update = useAtomSet(updateNoteAtom, { mode: "promiseExit" });
  const refreshList = useAtomRefresh(notesListAtom);
  const refreshNote = useAtomRefresh(noteAtom(note.id));

  const form = useForm(
    NoteInput,
    (payload) =>
      saveNote(
        () => update({ params: { id: note.id }, payload: notePatchOf(payload) }),
        "Note saved.",
        () => {
          refreshList();
          refreshNote();
        },
      ),
    { fork },
  );

  return (
    <form key={note.updatedAt.epochMilliseconds} {...form.formProps}>
      <NoteFields form={form} note={note} />
    </form>
  );
};
