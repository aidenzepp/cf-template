import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { useRouter } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { useEffect } from "react";
import { authClient } from "../../lib/auth-client.ts";
import type { fork as Fork } from "../../runtime.ts";
import { emailField, required } from "../form/fields.ts";
import { useForm } from "../form/use-form.ts";
import { authOutcome } from "./auth-outcome.ts";
import { PasswordResetNotice } from "./email-off-notices.tsx";
import { ProviderButtons } from "./provider-buttons.tsx";

/**
 * The fields of the sign-in form.
 */
export const SignInInput = Schema.Struct({
  email: emailField,
  password: required("Enter your password."),
});

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
 * @param props.fork - The web runtime's `fork`, injected so this module never loads the runtime.
 * @param props.providers -The provider ids of `AuthMethods`.
 * @param props.redirect - The validated root-relative path to open after sign-in.
 * @returns The form.
 */
export const SignInForm = ({
  email: emailLive,
  fork,
  providers,
  redirect,
}: {
  readonly email: boolean;
  readonly fork: typeof Fork;
  readonly providers: ReadonlyArray<string>;
  readonly redirect: string;
}) => {
  const router = useRouter();

  const { error, failure, field, formProps, pending } = useForm(
    SignInInput,
    ({ email, password }) =>
      authOutcome(
        (signal) => authClient.signIn.email({ email, password }, { signal }),
        () => {
          router.history.push(redirect);
        },
      ),
    { fork },
  );

  useEffect(() => {
    const controller = new AbortController();
    const credential = typeof PublicKeyCredential === "undefined" ? undefined : PublicKeyCredential;

    fork(passkeyAutofill(authClient.signIn.passkey, credential, controller.signal), {
      signal: controller.signal,
    });

    return () => {
      controller.abort();
    };
  }, [fork]);

  return (
    <>
      <form {...formProps}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              autoComplete={EMAIL_AUTOCOMPLETE}
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
              autoComplete="current-password"
              id="password"
              name="password"
              required
              type="password"
              {...field("password")}
            />
            <FieldError {...error("password")} />
          </Field>
          <FieldError>{failure}</FieldError>
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
