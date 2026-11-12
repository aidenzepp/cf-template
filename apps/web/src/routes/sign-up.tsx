import {
  createFileRoute,
  redirect,
  useLoaderData,
  useRouteContext,
  useSearch,
} from "@tanstack/react-router";
import { AuthFormShell } from "../components/auth/auth-form-shell.tsx";
import { SignUpForm } from "../components/auth/sign-up-form.tsx";
import { DEFAULT_REDIRECT, validateRedirectSearch } from "../lib/redirect-target.ts";
import { fork, run } from "../runtime.ts";
import { OrphanGraceSeconds } from "../web-layer.ts";

/**
 * The sign-up screen.
 *
 * @returns The page body.
 */
const SignUp = () => {
  const { authMethods } = useRouteContext({ from: "/sign-up" });
  const orphanGraceSeconds = useLoaderData({ from: "/sign-up" });
  const { redirect: requested } = useSearch({ from: "/sign-up" });
  const target = requested ?? DEFAULT_REDIRECT;

  return (
    <AuthFormShell
      description="Choose a name, an email and a password."
      otherLabel="Sign in instead"
      otherTo="/sign-in"
      redirect={requested}
      title="Create an account"
    >
      <SignUpForm
        email={authMethods.email}
        fork={fork}
        graceSeconds={orphanGraceSeconds}
        providers={authMethods.providers}
        redirect={target}
      />
    </AuthFormShell>
  );
};

export const Route = createFileRoute("/sign-up")({
  validateSearch: validateRedirectSearch,
  beforeLoad: ({ context }) => (context.session._tag === "signedIn" ? redirect({ to: "/" }) : {}),
  loader: () => run(OrphanGraceSeconds),
  component: SignUp,
});
