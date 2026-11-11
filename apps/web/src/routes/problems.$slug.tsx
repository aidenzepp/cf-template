import { Link, createFileRoute, useParams } from "@tanstack/react-router";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@workspace/ui/components/ui/empty";
import { problemCopy } from "../lib/problem-copy.ts";

/**
 * The page a problem's `type` URI points at. It shows authored copy for the slug and never a field
 * of a problem body.
 *
 * @returns The page body.
 */
const Problem = () => {
  const { slug } = useParams({ from: "/problems/$slug" });

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{problemCopy(slug)}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Link className="text-sm underline" to="/">
            Go home
          </Link>
        </EmptyContent>
      </Empty>
    </main>
  );
};

export const Route = createFileRoute("/problems/$slug")({ component: Problem });
