import { createFileRoute } from "@tanstack/react-router";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/ui/empty";

/**
 * The placeholder page `web` serves until the next UI is built.
 *
 * @returns The page body.
 */
const Placeholder = () => (
  <main className="flex min-h-svh">
    <Empty>
      <EmptyHeader>
        <EmptyTitle>typescript-template</EmptyTitle>
        <EmptyDescription>The next UI is built here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </main>
);

export const Route = createFileRoute("/")({
  component: Placeholder,
});
