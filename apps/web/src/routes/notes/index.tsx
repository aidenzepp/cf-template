import { HydrationBoundary, useAtomValue } from "@effect/atom-react";
import { createFileRoute, redirect, useLoaderData } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import { loadAtoms } from "../../load-atoms.ts";
import { run } from "../../runtime.ts";
import { notesListAtom } from "./-atoms.ts";
import { NoteForm } from "./-note-form.tsx";
import { noteFailureOf } from "./-note-failure.ts";
import { NoteList } from "./-note-list.tsx";
import { NotesUnavailablePage } from "./-notes-unavailable.tsx";

/**
 * The notes page body, or the unavailable page when the feature is off.
 *
 * @returns The page body.
 */
const NotesBody = () => {
  const list = useAtomValue(notesListAtom);

  return noteFailureOf(list) === "unavailable" ? (
    <NotesUnavailablePage />
  ) : (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <h1 className="text-lg font-semibold">Notes</h1>
      <NoteForm />
      <NoteList />
    </main>
  );
};

/**
 * The notes page: the create form and the list the loader dehydrated.
 *
 * @returns The page body.
 */
const Notes = () => {
  const state = useLoaderData({ from: "/notes/" });

  return (
    <HydrationBoundary state={state}>
      <NotesBody />
    </HydrationBoundary>
  );
};

export const Route = createFileRoute("/notes/")({
  beforeLoad: ({ context, location }) =>
    context.session._tag === "signedOut"
      ? redirect<AnyRouter>({ search: { redirect: location.href }, to: "/sign-in" })
      : {},
  component: Notes,
  loader: ({ abortController }) =>
    run(loadAtoms([notesListAtom]), { signal: abortController.signal }),
  staticData: { nav: { label: "Notes", order: 10 } },
});
