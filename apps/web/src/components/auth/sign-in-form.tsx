import { useAtom } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { FieldError, FieldGroup } from "@workspace/ui/components/ui/field";
import { Effect, Exit, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { authClient } from "../../lib/auth-client.ts";
import { authErrorCopy } from "../../lib/auth-error-copy.ts";
import { betterAuthCall } from "../../lib/better-auth-call.ts";
import type { fork as Fork } from "../../runtime.ts";
import { EmailAddress, focusFirstInvalid, formValidator, useAppForm } from "../form/form-hook.tsx";
import { PasswordResetNotice } from "./email-off-notices.tsx";
import { ProviderButtons } from "./provider-buttons.tsx";

/**
 * The fields of the sign-in form. Better Auth owns the real check of the credentials; the form
 * only asks for both before it calls.
 */
export const SignInInput = Schema.Struct({
  email: EmailAddress,
  password: Schema.String.check(Schema.isNonEmpty({ message: "Enter your password." })),
});

/**
 * The sign-in submit: one call at a time, the previous run interrupted (which aborts its request)
 * when a new one starts or the form unmounts. A refused call fails with `AuthCallFailed`.
 */
export const signInAtom = Atom.fn((credentials: typeof SignInInput.Type) =>
  betterAuthCall((signal) => authClient.signIn.email(credentials, { signal })),
);

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
  const [result, submit] = useAtom(signInAtom, { mode: "promiseExit" });
  const failure = AsyncResult.error(result);

  const form = useAppForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      if (Exit.isSuccess(await submit(value))) {
        router.history.push(redirect);
      }
    },
    onSubmitInvalid: focusFirstInvalid,
    validators: { onSubmit: formValidator(SignInInput) },
  });

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
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.AppField name="email">
            {(field) => (
              <field.TextField
                autoComplete={EMAIL_AUTOCOMPLETE}
                label="Email"
                required
                type="email"
              />
            )}
          </form.AppField>
          <form.AppField name="password">
            {(field) => (
              <field.TextField
                autoComplete="current-password"
                label="Password"
                required
                type="password"
              />
            )}
          </form.AppField>
          <FieldError>
            {Option.match(failure, {
              onNone: () => null,
              onSome: ({ error }) => authErrorCopy({ aborted: false, error }),
            })}
          </FieldError>
          <form.AppForm>
            <form.SubmitButton>Sign in</form.SubmitButton>
          </form.AppForm>
        </FieldGroup>
      </form>
      <PasswordResetNotice email={emailLive} />
      <ProviderButtons callbackURL={redirect} providers={providers} />
    </>
  );
};
