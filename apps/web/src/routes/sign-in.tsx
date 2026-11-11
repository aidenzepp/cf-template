import { createFileRoute, redirect, useRouteContext, useSearch } from "@tanstack/react-router";
import { AuthFormShell } from "../components/auth/auth-form-shell.tsx";
import { SignInForm } from "../components/auth/sign-in-form.tsx";
import { DEFAULT_REDIRECT, validateRedirectSearch } from "../lib/redirect-target.ts";

/**
 * The sign-in screen.
 *
 * @returns The page body.
 */
const SignIn = () => {
  const { authMethods } = useRouteContext({ from: "/sign-in" });
  const { redirect: requested } = useSearch({ from: "/sign-in" });
  const target = requested ?? DEFAULT_REDIRECT;

  return (
    <AuthFormShell
      description="Use your email and password."
      otherLabel="Create an account"
      otherTo="/sign-up"
      redirect={requested}
      title="Sign in"
    >
      <SignInForm providers={authMethods.providers} redirect={target} />
    </AuthFormShell>
  );
};

export const Route = createFileRoute("/sign-in")({
  beforeLoad: ({ context }) => (context.session._tag === "signedIn" ? redirect({ to: "/" }) : {}),
  component: SignIn,
  validateSearch: validateRedirectSearch,
});
