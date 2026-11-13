import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/ui/empty";

/**
 * The page for a path no route matches or a thrown `notFound()`. The router answers 404.
 *
 * @returns The page body.
 */
export const NotFoundPage = () => (
  <main className="flex min-h-svh">
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Page not found</EmptyTitle>
        <EmptyDescription>The link may be broken, or the page may have moved.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button nativeButton={false} render={<Link to="/" />}>
          Go to the home page
        </Button>
      </EmptyContent>
    </Empty>
  </main>
);

/**
 * The page for an error thrown in a loader, `beforeLoad` or render. The router answers 500, or the
 * status the throwing code set. The thrown error is never rendered.
 *
 * @param props - The boundary's `reset`, which clears the caught error.
 * @returns The page body.
 */
export const RouteErrorPage = ({ reset }: { readonly reset: () => void }) => {
  const router = useRouter();

  return (
    <main className="flex min-h-svh">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>This page couldn&apos;t load</EmptyTitle>
          <EmptyDescription>
            Something went wrong. Try again, or go to the home page.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            onClick={() => {
              reset();
              void router.invalidate();
            }}
          >
            Try again
          </Button>
          <Button nativeButton={false} render={<Link to="/" />} variant="outline">
            Go to the home page
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  );
};
