import { Link, createFileRoute } from "@tanstack/react-router";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/ui/empty";

/**
 * The outage page. It is a session-less path, so it renders without reading the session from the
 * service that failed.
 *
 * @returns The page body.
 */
const Unavailable = () => (
  <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Sign-in is unavailable right now.</EmptyTitle>
        <EmptyDescription>Try again in a few minutes.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link className="text-sm underline" to="/">
          Try again
        </Link>
      </EmptyContent>
    </Empty>
  </main>
);

export const Route = createFileRoute("/unavailable")({ component: Unavailable });
