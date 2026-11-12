import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { useRouter } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { useEffect } from "react";
import { authClient } from "../../lib/auth-client.ts";
import { recordMethod } from "../../lib/last-method.ts";
import type { SignInMethod } from "../../lib/last-method.ts";
import { settle } from "../../lib/settings-calls.ts";
import type { Settled } from "../../lib/settings-calls.ts";
import type { fork as Fork } from "../../runtime.ts";
import { emailField, required } from "../form/fields.ts";
import { useAction, useForm } from "../form/use-form.ts";
import { authOutcome } from "./auth-outcome.ts";
import { PasswordResetNotice } from "./email-off-notices.tsx";
import { ProviderButtons } from "./provider-buttons.tsx";
import { browserStore, useLastMethod } from "./use-last-method.ts";

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
 * as available. A failure at any step, including an abort, is dropped without output; a success
 * runs `onSaved`.
 *
 * @param signIn - Runs `signIn.passkey`.
 * @param credential - `PublicKeyCredential`, or `undefined` when the browser has none.
 * @param signal - Aborted when the form unmounts; also stops a call that has not started.
 * @param onSaved - Runs after a successful sign-in, to record it and open the next screen.
 * @returns The effect to run.
 */
export const passkeyAutofill = (
  signIn: (options: {
    readonly autoFill: true;
    readonly fetchOptions: { readonly signal: AbortSignal };
  }) => PromiseLike<Settled>,
  credential: ConditionalMediation | undefined,
  signal: AbortSignal,
  onSaved: () => void,
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
      const { error } = yield* settle(() => signIn({ autoFill: true, fetchOptions: { signal } }));

      if (error === null) {
        yield* Effect.sync(onSaved);
      }
    }
  }).pipe(Effect.ignore);

/**
 * What a successful sign-in does: record the method on this device, then open the next screen. The
 * record is written first, so the next screen never opens before it exists.
 *
 * @param fork - The web runtime's `fork`.
 * @param method - The method that signed the person in.
 * @param history - The router's history.
 * @param history.push - Opens a path.
 * @param redirect - The validated root-relative path to open.
 * @returns The function to run once the call has succeeded.
 */
const finishSignIn =
  (
    fork: typeof Fork,
    method: SignInMethod,
    history: { readonly push: (to: string) => void },
    redirect: string,
  ) =>
  () => {
    fork(
      recordMethod(browserStore, method).pipe(
        Effect.andThen(
          Effect.sync(() => {
            history.push(redirect);
          }),
        ),
      ),
    );
  };

/**
 * The "Last used" tag inside the button of the method a person signed in with last. `Button`
 * styles an element marked `data-badge`.
 *
 * @param props - The tag's props.
 * @param props.shown - Whether this is the last-used method.
 * @returns The tag, or nothing.
 */
export const LastUsed = ({ shown }: { readonly shown: boolean }) =>
  shown ? <span data-badge>Last used</span> : null;

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
  const { history } = useRouter();
  const lastMethod = useLastMethod(fork);

  const { error, failure, field, formProps, pending } = useForm(
    SignInInput,
    ({ email, password }) =>
      authOutcome(
        (signal) => authClient.signIn.email({ email, password }, { signal }),
        finishSignIn(fork, "email", history, redirect),
      ),
    { fork },
  );

  const passkey = useAction({ fork });

  useEffect(() => {
    const controller = new AbortController();
    const credential = typeof PublicKeyCredential === "undefined" ? undefined : PublicKeyCredential;

    fork(
      passkeyAutofill(
        authClient.signIn.passkey,
        credential,
        controller.signal,
        finishSignIn(fork, "passkey", history, redirect),
      ),
      { signal: controller.signal },
    );

    return () => {
      controller.abort();
    };
  }, [fork, history, redirect]);

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
          <Button disabled={pending} size="lg" type="submit">
            Sign in
            <LastUsed shown={lastMethod === "email"} />
          </Button>
        </FieldGroup>
      </form>
      <PasswordResetNotice email={emailLive} />
      <div aria-hidden className="flex items-center gap-3 text-muted-foreground text-xs">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-2">
        <Button
          disabled={passkey.pending}
          onClick={() => {
            passkey.run(
              authOutcome(
                (signal) => authClient.signIn.passkey({ fetchOptions: { signal } }),
                finishSignIn(fork, "passkey", history, redirect),
              ),
            );
          }}
          size="lg"
          type="button"
          variant="outline"
        >
          Sign in with a passkey
          <LastUsed shown={lastMethod === "passkey"} />
        </Button>
        <FieldError>{passkey.failure}</FieldError>
      </div>
      <ProviderButtons callbackURL={redirect} providers={providers} />
    </>
  );
};
