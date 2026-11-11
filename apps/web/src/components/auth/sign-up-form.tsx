import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { useState } from "react";
import type { SyntheticEvent } from "react";
import { authClient } from "../../lib/auth-client.ts";
import { PasskeyNudge } from "./email-off-notices.tsx";
import { ProviderButtons } from "./provider-buttons.tsx";
import { readField, useAuthSubmit } from "./use-auth-submit.ts";

/**
 * The line that tells a person how long an abandoned sign-up holds its email, or `null` when the
 * failure is not one the grace explains. It follows `authErrorCopy`'s own line for the same error.
 *
 * @param error - The failed call's status and code.
 * @param error.status - The HTTP status of the failure.
 * @param error.code - The Better Auth error code, when there is one.
 * @param graceSeconds - The bound `AUTH_ORPHAN_GRACE_SECONDS`.
 * @returns The grace line, or `null`.
 */
export const orphanGraceLine = (
  error: { readonly status: number; readonly code?: string | undefined },
  graceSeconds: number,
): string | null => {
  const count = Math.ceil(graceSeconds / 60);
  const minutes = count === 1 ? "1 minute" : `${count} minutes`;

  if (error.status >= 500) {
    return `We couldn't finish creating your account. Wait ${minutes}, then sign up again with the same email, or use another email.`;
  }

  return error.code === "USER_ALREADY_EXISTS"
    ? `If you just tried to sign up and it failed, wait ${minutes} and sign up again.`
    : null;
};

/**
 * The email and password sign-up form. A new account is signed in at once.
 *
 * @param props - The form's props.
 * @param props.email - `AuthMethods.email`: whether reset mail exists.
 * @param props.graceSeconds - The bound `AUTH_ORPHAN_GRACE_SECONDS`, for the grace lines.
 * @param props.providers -The provider ids of `AuthMethods`.
 * @param props.redirect - The validated root-relative path to open after sign-up.
 * @returns The form.
 */
export const SignUpForm = ({
  email: emailLive,
  graceSeconds,
  providers,
  redirect,
}: {
  readonly email: boolean;
  readonly graceSeconds: number;
  readonly providers: ReadonlyArray<string>;
  readonly redirect: string;
}) => {
  const { message, pending, submit } = useAuthSubmit(redirect);
  const [graceLine, setGraceLine] = useState<string | null>(null);

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const name = readField(form, "name");
    const email = readField(form, "email");
    const password = readField(form, "password");

    setGraceLine(null);
    submit((signal) =>
      authClient.signUp.email(
        { email, name, password },
        {
          onError: ({ error }) => {
            setGraceLine(orphanGraceLine(error, graceSeconds));
          },
          signal,
        },
      ),
    );
  };

  return (
    <>
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input autoComplete="name" id="name" name="name" required type="text" />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input autoComplete="email" id="email" name="email" required type="email" />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              autoComplete="new-password"
              id="password"
              name="password"
              required
              type="password"
            />
          </Field>
          <FieldError>{message}</FieldError>
          {message === null || graceLine === null ? null : (
            <p className="text-muted-foreground text-sm">{graceLine}</p>
          )}
          <Button disabled={pending} type="submit">
            Create account
          </Button>
        </FieldGroup>
      </form>
      <PasskeyNudge email={emailLive} />
      <ProviderButtons callbackURL={redirect} providers={providers} />
    </>
  );
};
