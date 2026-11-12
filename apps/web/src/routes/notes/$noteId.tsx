import { HydrationBoundary, useAtomValue } from "@effect/atom-react";
import { createFileRoute, redirect, useLoaderData, useParams } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import { NoteId } from "@workspace/contract/domain/note";
import { Skeleton } from "@workspace/ui/components/ui/skeleton";
import { AsyncResult } from "effect/reactivity";
import { loadAtoms } from "../../load-atoms.ts";
import { run } from "../../runtime.ts";
import { noteAtom } from "./-atoms.ts";
import { DeleteNoteButton } from "./-delete-note-button.tsx";
import { noteFailureOf } from "./-note-failure.ts";
import { EditNoteForm } from "./-note-form.tsx";
import { NotesUnavailablePage } from "./-notes-unavailable.tsx";

/**
 * The route's not-found component: no note has the requested id.
 *
 * @returns The page body.
 */
const NoteMissing = () => (
  <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
    <h1 className="text-lg font-semibold">Note not found</h1>
    <p>No note has this id. It may have been deleted.</p>
  </main>
);

/**
 * The note named by the path: its edit form and delete button, the not-found component for an
 * unknown id, or the unavailable page when the feature is off.
 *
 * @returns The page body.
 */
const NoteDetail = () => {
  const { noteId } = useParams({ from: "/notes/$noteId" });
  const id = NoteId.make(noteId);
  const result = useAtomValue(noteAtom(id));
  const failure = noteFailureOf(result);

  if (failure === "unavailable") {
    return <NotesUnavailablePage />;
  }

  if (failure === "missing") {
    return <NoteMissing />;
  }

  if (failure === "other") {
    return <p role="alert">The note could not be loaded.</p>;
  }

  if (!AsyncResult.isSuccess(result)) {
    return <Skeleton aria-label="Loading note" className="h-16 w-full" />;
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <h1 className="text-lg font-semibold">Edit note</h1>
      <EditNoteForm note={result.value} />
      <DeleteNoteButton id={result.value.id} />
    </main>
  );
};

/**
 * The page of one note: hydrates the note the loader dehydrated.
 *
 * @returns The page body.
 */
const NotePage = () => {
  const state = useLoaderData({ from: "/notes/$noteId" });

  return (
    <HydrationBoundary state={state}>
      <NoteDetail />
    </HydrationBoundary>
  );
};

export const Route = createFileRoute("/notes/$noteId")({
  beforeLoad: ({ context, location }) =>
    context.session._tag === "signedOut"
      ? redirect<AnyRouter>({ search: { redirect: location.href }, to: "/sign-in" })
      : {},
  component: NotePage,
  loader: ({ abortController, params }) =>
    run(loadAtoms([noteAtom(NoteId.make(params.noteId))]), { signal: abortController.signal }),
  notFoundComponent: NoteMissing,
});
