import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@workspace/ui/components/ui/empty";

/**
 * The page of a route that threw. It never shows the thrown value or a stack: the person gets two
 * ways out, running the route's loaders again or going home.
 *
 * @returns The page body.
 */
export const RouteError = () => {
  const router = useRouter();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Something went wrong and the page couldn&apos;t load.</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button
            onClick={() => {
              void router.invalidate();
            }}
          >
            Try again
          </Button>
          <Link className="text-sm underline" to="/">
            Go to the home page
          </Link>
        </EmptyContent>
      </Empty>
    </main>
  );
};
