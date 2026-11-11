import { Link } from "@tanstack/react-router";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@workspace/ui/components/ui/empty";

/**
 * The page of a path no route matches, or of a loader that reports its record missing.
 *
 * @returns The page body.
 */
export const NotFound = () => (
  <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
    <Empty>
      <EmptyHeader>
        <EmptyTitle>This page doesn&apos;t exist.</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Link className="text-sm underline" to="/">
          Go to the home page
        </Link>
      </EmptyContent>
    </Empty>
  </main>
);
