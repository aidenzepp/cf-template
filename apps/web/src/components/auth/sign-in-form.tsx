import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import type { SyntheticEvent } from "react";
import { authClient } from "../../lib/auth-client.ts";
import { ProviderButtons } from "./provider-buttons.tsx";
import { readField, useAuthSubmit } from "./use-auth-submit.ts";

/**
 * The email and password sign-in form, with a button per live provider.
 *
 * @param props - The form's props.
 * @param props.providers - The provider ids of `AuthMethods`.
 * @param props.redirect - The validated root-relative path to open after sign-in.
 * @returns The form.
 */
export const SignInForm = ({
  providers,
  redirect,
}: {
  readonly providers: readonly string[];
  readonly redirect: string;
}) => {
  const { message, pending, submit } = useAuthSubmit(redirect);

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const email = readField(form, "email");
    const password = readField(form, "password");

    submit((signal) => authClient.signIn.email({ email, password }, { signal }));
  };

  return (
    <>
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input autoComplete="email" id="email" name="email" required type="email" />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              autoComplete="current-password"
              id="password"
              name="password"
              required
              type="password"
            />
          </Field>
          <FieldError>{message}</FieldError>
          <Button disabled={pending} type="submit">
            Sign in
          </Button>
        </FieldGroup>
      </form>
      <ProviderButtons callbackURL={redirect} providers={providers} />
    </>
  );
};
