import { Link, createFileRoute, useSearch } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import { oauthErrorCode, oauthErrorCopy } from "../lib/oauth-error-copy.ts";

/**
 * Where Better Auth sends a failed OAuth callback. It shows fixed copy chosen from the `error`
 * code and nothing else from the query.
 *
 * @returns The page body.
 */
const OAuthError = () => {
  const { error } = useSearch({ from: "/oauth-error" });

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>We couldn't sign you in</CardTitle>
          <CardDescription>{oauthErrorCopy(error)}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link className="text-sm underline" search={{ redirect: undefined }} to="/sign-in">
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/oauth-error")({
  component: OAuthError,
  // The router keeps unvalidated query keys in the URL. Rebuild the search from the one allowlisted
  // `error`, so provider and attacker text does not stay in the address bar, history or later
  // access logs.
  search: { middlewares: [({ search }) => ({ error: search.error })] },
  // Only `error` is read, as a lookup key. `error_description` and any other value are dropped.
  validateSearch: (search: { readonly error?: unknown }) => ({
    error: oauthErrorCode(search.error),
  }),
});
