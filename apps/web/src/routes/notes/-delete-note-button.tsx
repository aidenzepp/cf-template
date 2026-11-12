import { useAtom } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/ui/button";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { NoteId } from "@workspace/contract/domain/note";
import { notify } from "../../components/notify.ts";
import { NOTES_KEY, deleteNoteAtom } from "./-atoms.ts";

/**
 * The button that deletes a note. A deleted note raises a toast, re-reads the list through the
 * `notes` reactivity key, and returns the page to the list.
 *
 * @param props - The button's props.
 * @param props.id - The note to delete.
 * @returns The button and the line for a failed call.
 */
export const DeleteNoteButton = ({ id }: { readonly id: typeof NoteId.Type }) => {
  const [result, remove] = useAtom(deleteNoteAtom, { mode: "promiseExit" });
  const navigate = useNavigate();

  const onDelete = async () => {
    const exit = await remove({ params: { id }, reactivityKeys: [NOTES_KEY] });

    if (Exit.isSuccess(exit)) {
      notify.success("Note deleted");
      await navigate({ to: "/notes" });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        disabled={result.waiting}
        onClick={() => {
          void onDelete();
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
