import { useAtom } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { FieldError, FieldGroup } from "@workspace/ui/components/ui/field";
import { Exit, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { authClient } from "../../lib/auth-client.ts";
import { authErrorCopy } from "../../lib/auth-error-copy.ts";
import { betterAuthCall } from "../../lib/better-auth-call.ts";
import { EmailAddress, focusFirstInvalid, formValidator, useAppForm } from "../form/form-hook.tsx";
import { PasskeyNudge } from "./email-off-notices.tsx";
import { ProviderButtons } from "./provider-buttons.tsx";

/**
 * The fields of the sign-up form. Better Auth owns the rules of the password; the form only asks
 * for all three before it calls.
 */
export const SignUpInput = Schema.Struct({
  email: EmailAddress,
  name: Schema.String.check(Schema.isNonEmpty({ message: "Enter your name." })),
  password: Schema.String.check(Schema.isNonEmpty({ message: "Choose a password." })),
});

/**
 * The sign-up submit: one call at a time, the previous run interrupted (which aborts its request)
 * when a new one starts or the form unmounts. A refused call fails with `AuthCallFailed`.
 */
export const signUpAtom = Atom.fn((input: typeof SignUpInput.Type) =>
  betterAuthCall((signal) => authClient.signUp.email(input, { signal })),
);

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
  const router = useRouter();
  const [result, submit] = useAtom(signUpAtom, { mode: "promiseExit" });
  const failure = AsyncResult.error(result);

  const graceLine = failure.pipe(
    Option.flatMap(({ error }) => Option.fromNullishOr(orphanGraceLine(error, graceSeconds))),
    Option.getOrNull,
  );

  const form = useAppForm({
    defaultValues: { email: "", name: "", password: "" },
    onSubmit: async ({ value }) => {
      if (Exit.isSuccess(await submit(value))) {
        router.history.push(redirect);
      }
    },
    onSubmitInvalid: focusFirstInvalid,
    validators: { onSubmit: formValidator(SignUpInput) },
  });

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
          <form.AppField name="name">
            {(field) => <field.TextField autoComplete="name" label="Name" required type="text" />}
          </form.AppField>
          <form.AppField name="email">
            {(field) => (
              <field.TextField autoComplete="email" label="Email" required type="email" />
            )}
          </form.AppField>
          <form.AppField name="password">
            {(field) => (
              <field.TextField
                autoComplete="new-password"
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
          {graceLine === null ? null : <p className="text-muted-foreground text-sm">{graceLine}</p>}
          <form.AppForm>
            <form.SubmitButton>Create account</form.SubmitButton>
          </form.AppForm>
        </FieldGroup>
      </form>
      <PasskeyNudge email={emailLive} />
      <ProviderButtons callbackURL={redirect} providers={providers} />
    </>
  );
};
