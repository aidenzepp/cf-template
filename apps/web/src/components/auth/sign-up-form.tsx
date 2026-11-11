import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import type { SyntheticEvent } from "react";
import { authClient } from "../../lib/auth-client.ts";
import { ProviderButtons } from "./provider-buttons.tsx";
import { readField, useAuthSubmit } from "./use-auth-submit.ts";

/**
 * The email and password sign-up form. A new account is signed in at once.
 *
 * @param props - The form's props.
 * @param props.providers - The provider ids of `AuthMethods`.
 * @param props.redirect - The validated root-relative path to open after sign-up.
 * @returns The form.
 */
export const SignUpForm = ({
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
    const name = readField(form, "name");
    const email = readField(form, "email");
    const password = readField(form, "password");

    submit((signal) => authClient.signUp.email({ email, name, password }, { signal }));
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
          <Button disabled={pending} type="submit">
            Create account
          </Button>
        </FieldGroup>
      </form>
      <ProviderButtons callbackURL={redirect} providers={providers} />
    </>
  );
};
