import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { Effect } from "effect";
import { useEffect } from "react";
import type { SyntheticEvent } from "react";
import { authClient } from "../../lib/auth-client.ts";
import { PasswordResetNotice } from "./email-off-notices.tsx";
import { ProviderButtons } from "./provider-buttons.tsx";
import { readField, useAuthSubmit } from "./use-auth-submit.ts";

/**
 * The email input's `autocomplete` tokens: `webauthn` lets the browser offer saved passkeys in the
 * field's autofill menu.
 */
export const EMAIL_AUTOCOMPLETE = "username webauthn";

/**
 * The browser's `PublicKeyCredential` as far as the autofill guard reads it.
 */
interface ConditionalMediation {
  readonly isConditionalMediationAvailable?: () => Promise<boolean>;
}

/**
 * Starts the conditional-UI passkey sign-in, only when the browser reports conditional mediation
 * as available. A failure at any step, including an abort, is dropped without output.
 *
 * @param signIn - Runs `signIn.passkey`.
 * @param credential - `PublicKeyCredential`, or `undefined` when the browser has none.
 * @param signal - Aborted when the form unmounts; also stops a call that has not started.
 * @returns The effect to run.
 */
export const passkeyAutofill = <Result,>(
  signIn: (options: {
    readonly autoFill: true;
    readonly fetchOptions: { readonly signal: AbortSignal };
  }) => PromiseLike<Result>,
  credential: ConditionalMediation | undefined,
  signal: AbortSignal,
) =>
  Effect.gen(function* autofill() {
    const detect = credential?.isConditionalMediationAvailable;

    if (detect === undefined) {
      return;
    }

    const available = yield* Effect.tryPromise({
      catch: () => false,
      try: () => detect.call(credential),
    });

    if (available && !signal.aborted) {
      yield* Effect.tryPromise({
        catch: () => false,
        try: () => signIn({ autoFill: true, fetchOptions: { signal } }),
      });
    }
  }).pipe(Effect.ignore);

/**
 * The email and password sign-in form, with a button per live provider.
 *
 * @param props - The form's props.
 * @param props.email - `AuthMethods.email`: whether reset mail exists.
 * @param props.providers -The provider ids of `AuthMethods`.
 * @param props.redirect - The validated root-relative path to open after sign-in.
 * @returns The form.
 */
export const SignInForm = ({
  email: emailLive,
  providers,
  redirect,
}: {
  readonly email: boolean;
  readonly providers: readonly string[];
  readonly redirect: string;
}) => {
  const { message, pending, submit } = useAuthSubmit(redirect);

  useEffect(() => {
    const controller = new AbortController();
    const credential = typeof PublicKeyCredential === "undefined" ? undefined : PublicKeyCredential;

    Effect.runFork(passkeyAutofill(authClient.signIn.passkey, credential, controller.signal));

    return () => {
      controller.abort();
    };
  }, []);

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
            <Input
              autoComplete={EMAIL_AUTOCOMPLETE}
              id="email"
              name="email"
              required
              type="email"
            />
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
      <PasswordResetNotice email={emailLive} />
      <ProviderButtons callbackURL={redirect} providers={providers} />
    </>
  );
};
