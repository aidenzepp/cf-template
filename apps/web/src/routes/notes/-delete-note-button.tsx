import { useAtom, useAtomRefresh } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/ui/button";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import type { NoteId } from "@workspace/contract/domain/note";
import { deleteNoteAtom, notesListAtom } from "./-atoms.ts";

/**
 * The button that deletes a note. After a successful call the list re-reads from the server once
 * and the page returns to the list.
 *
 * @param props - The button's props.
 * @param props.id - The note to delete.
 * @returns The button and the line for a failed call.
 */
export const DeleteNoteButton = ({ id }: { readonly id: typeof NoteId.Type }) => {
  const [result, remove] = useAtom(deleteNoteAtom);
  const refreshList = useAtomRefresh(notesListAtom);
  const navigate = useNavigate();

  useEffect(() => {
    if (AsyncResult.isSuccess(result) && !result.waiting) {
      refreshList();
      void navigate({ to: "/notes" });
    }
  }, [result, refreshList, navigate]);

  return (
    <div className="flex flex-col gap-2">
      <Button
        disabled={result.waiting}
        onClick={() => {
          remove({ params: { id } });
        }}
        type="button"
        variant="destructive"
      >
        Delete note
      </Button>
      {AsyncResult.isFailure(result) ? <p role="alert">The note could not be deleted.</p> : null}
    </div>
  );
};
