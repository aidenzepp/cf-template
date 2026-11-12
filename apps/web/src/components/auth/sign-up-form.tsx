import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { useRouter } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { authClient } from "../../lib/auth-client.ts";
import type { fork as Fork } from "../../runtime.ts";
import { emailField, required } from "../form/fields.ts";
import { useForm } from "../form/use-form.ts";
import { authOutcome } from "./auth-outcome.ts";
import { PasskeyNudge } from "./email-off-notices.tsx";
import { ProviderButtons } from "./provider-buttons.tsx";

/**
 * The fields of the sign-up form.
 */
export const SignUpInput = Schema.Struct({
  email: emailField,
  name: required("Enter your name."),
  password: required("Choose a password."),
});

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
 * @param props.fork - The web runtime's `fork`, injected so this module never loads the runtime.
 * @param props.graceSeconds - The bound `AUTH_ORPHAN_GRACE_SECONDS`, for the grace lines.
 * @param props.providers -The provider ids of `AuthMethods`.
 * @param props.redirect - The validated root-relative path to open after sign-up.
 * @returns The form.
 */
export const SignUpForm = ({
  email: emailLive,
  fork,
  graceSeconds,
  providers,
  redirect,
}: {
  readonly email: boolean;
  readonly fork: typeof Fork;
  readonly graceSeconds: number;
  readonly providers: ReadonlyArray<string>;
  readonly redirect: string;
}) => {
  const router = useRouter();
  const [graceLine, setGraceLine] = useState<string | null>(null);

  const { error, failure, field, formProps, pending } = useForm(
    SignUpInput,
    ({ email, name, password }) => {
      setGraceLine(null);

      return authOutcome(
        (signal) =>
          authClient.signUp.email(
            { email, name, password },
            {
              onError: ({ error: failed }) => {
                setGraceLine(orphanGraceLine(failed, graceSeconds));
              },
              signal,
            },
          ),
        () => {
          router.history.push(redirect);
        },
      );
    },
    { fork },
  );

  return (
    <>
      <form {...formProps}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              autoComplete="name"
              id="name"
              name="name"
              required
              type="text"
              {...field("name")}
            />
            <FieldError {...error("name")} />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              autoComplete="email"
              id="email"
              name="email"
              required
              type="email"
              {...field("email")}
            />
            <FieldError {...error("email")} />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              autoComplete="new-password"
              id="password"
              name="password"
              required
              type="password"
              {...field("password")}
            />
            <FieldError {...error("password")} />
          </Field>
          <FieldError>{failure}</FieldError>
          {failure === null || graceLine === null ? null : (
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
