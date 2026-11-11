import { useRouter } from "@tanstack/react-router";
import { AuthUnavailable } from "@workspace/contract/domain/auth-errors";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/ui/empty";

/**
 * The message of an {@link AuthUnavailable}. The router serializes an error to its message alone,
 * so the browser recognizes the failure by this text, not by its class.
 */
const AUTH_UNAVAILABLE_MESSAGE = new AuthUnavailable({ retryAfterSeconds: 0 }).message;

/**
 * Whether a route error is the sign-in outage the root `beforeLoad` reports.
 *
 * @param error - The error the router hands to the root `errorComponent`.
 * @returns `true` for an {@link AuthUnavailable}, on the server and after hydration.
 */
export const isAuthUnavailable = (error: Error): boolean =>
  error.message === AUTH_UNAVAILABLE_MESSAGE;

/**
 * The retry screen of a session read that could not complete. It clears nothing: the person stays
 * signed in, and the button runs the route's loaders again.
 *
 * @returns The screen.
 */
export const Retry = () => {
  const router = useRouter();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>We could not check your sign-in.</EmptyTitle>
          <EmptyDescription>
            This page needs it. You are not signed out. Try again in a moment.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            onClick={() => {
              void router.invalidate();
            }}
          >
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  );
};
