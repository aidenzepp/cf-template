import { useAtom, useAtomRefresh } from "@effect/atom-react";
import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { Textarea } from "@workspace/ui/components/ui/textarea";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { createNoteAtom, notesListAtom } from "./-atoms.ts";
import { readNoteCreate } from "./-note-input.ts";

/**
 * The line shown for the result of the last create call.
 *
 * @param result - The create atom's value.
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
 * The form that creates a note. After a successful call the list re-reads from the server once and
 * the form clears.
 *
 * @returns The form.
 */
export const NoteForm = () => {
  const [result, create] = useAtom(createNoteAtom);
  const refreshList = useAtomRefresh(notesListAtom);
  const form = useRef<HTMLFormElement>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (AsyncResult.isSuccess(result) && !result.waiting) {
      form.current?.reset();
      refreshList();
    }
  }, [result, refreshList]);

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();

    const payload = readNoteCreate(new FormData(event.currentTarget));

    setInvalid(Option.isNone(payload));

    if (Option.isSome(payload)) {
      create({ payload: payload.value });
    }
  };

  const message = invalid ? "Enter a title and a body." : failureLine(result);

  return (
    <form onSubmit={onSubmit} ref={form}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="title">Title</FieldLabel>
          <Input id="title" name="title" required type="text" />
        </Field>
        <Field>
          <FieldLabel htmlFor="body">Body</FieldLabel>
          <Textarea id="body" name="body" />
        </Field>
        <FieldError>{message}</FieldError>
        <Button disabled={result.waiting} type="submit">
          Create note
        </Button>
      </FieldGroup>
    </form>
  );
};
