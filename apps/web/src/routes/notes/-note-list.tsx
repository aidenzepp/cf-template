import { useAtomValue } from "@effect/atom-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/ui/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@workspace/ui/components/ui/item";
import { Skeleton } from "@workspace/ui/components/ui/skeleton";
import { AsyncResult } from "effect/reactivity";
import { notesListAtom } from "./-atoms.ts";

/**
 * The caller's notes, read from the list atom the loader hydrated.
 *
 * @returns The list, its empty state, a placeholder while the list loads, or the line for a failed
 *   load.
 */
export const NoteList = () => {
  const result = useAtomValue(notesListAtom);

  if (AsyncResult.isFailure(result)) {
    return <p role="alert">Notes could not be loaded.</p>;
  }

  if (!AsyncResult.isSuccess(result)) {
    return <Skeleton aria-label="Loading notes" className="h-16 w-full" />;
  }

  if (result.value.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No notes yet</EmptyTitle>
          <EmptyDescription>Create one with the form.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ItemGroup aria-label="Notes">
      {result.value.map((note) => (
        <Item key={note.id} variant="outline">
          <ItemContent>
            <ItemTitle>{note.title}</ItemTitle>
            <ItemDescription>{note.body}</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
};
