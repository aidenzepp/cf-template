import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/ui/empty";

/**
 * The page shown when the example notes feature is switched off.
 *
 * @returns The page body.
 */
export const NotesUnavailablePage = () => (
  <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Notes are turned off on this site.</EmptyTitle>
        <EmptyDescription>Ask the site owner to turn them on.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </main>
);
