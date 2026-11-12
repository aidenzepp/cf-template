import { useAtom } from "@effect/atom-react";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/ui/dialog";
import { FieldError, FieldGroup } from "@workspace/ui/components/ui/field";
import { Effect, Exit, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";
import { authClient } from "../../lib/auth-client.ts";
import { authErrorCopy } from "../../lib/auth-error-copy.ts";
import { betterAuthCall } from "../../lib/better-auth-call.ts";
import { decodeAccounts, providerName, reauthProviders } from "../../lib/settings-calls.ts";
import { run } from "../../runtime.ts";
import { focusFirstInvalid, formValidator, useAppForm } from "../form/form-hook.tsx";

/**
 * The field of the password prompt.
 */
const PasswordInput = Schema.Struct({
  password: Schema.String.check(Schema.isNonEmpty({ message: "Enter your password." })),
});

/**
 * How a person signs in again: with the password of the account, or through a linked provider.
 */
type Answer = { readonly email: string; readonly password: string } | { readonly provider: string };

/**
 * The sign-in that makes the session fresh: one call at a time, the previous run interrupted (which
 * aborts its request) when a new one starts or the prompt closes. A refused call fails with
 * `AuthCallFailed`.
 */
const reauthAtom = Atom.fn((answer: Answer) =>
  betterAuthCall((signal) =>
    "provider" in answer
      ? authClient.signIn.social(
          { callbackURL: "/settings", provider: answer.provider },
          { signal },
        )
      : authClient.signIn.email(answer, { signal }),
  ),
);

/**
 * The prompt's body: the password form, or a button per linked provider for an account without a
 * password. It mounts with the dialog, so a closed prompt keeps no password and no failure line.
 *
 * @param props - The body's props.
 * @param props.email - The email of the signed-in account.
 * @param props.onDone - Called after the session is fresh again.
 * @param props.providers - The providers to offer; none asks for the password.
 * @returns The body.
 */
const Answers = ({
  email,
  onDone,
  providers,
}: {
  readonly email: string;
  readonly onDone: () => void;
  readonly providers: ReadonlyArray<string>;
}) => {
  const [result, submit] = useAtom(reauthAtom, { mode: "promiseExit" });
  const failure = AsyncResult.error(result);

  const answer = async (how: Answer) => {
    if (Exit.isSuccess(await submit(how))) {
      onDone();
    }
  };

  const form = useAppForm({
    defaultValues: { password: "" },
    onSubmit: ({ value }) => answer({ email, password: value.password }),
    onSubmitInvalid: focusFirstInvalid,
    validators: { onSubmit: formValidator(PasswordInput) },
  });

  const failureLine = (
    <FieldError>
      {Option.match(failure, {
        onNone: () => null,
        onSome: ({ error }) => authErrorCopy({ aborted: false, error }),
      })}
    </FieldError>
  );

  return providers.length === 0 ? (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
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
        {failureLine}
        <form.AppForm>
          <form.SubmitButton>Continue</form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  ) : (
    <FieldGroup>
      {providers.map((provider) => (
        <Button
          disabled={AsyncResult.isWaiting(result)}
          key={provider}
          onClick={() => {
            void answer({ provider });
          }}
          type="button"
        >
          {`Sign in again with ${providerName(provider)}`}
        </Button>
      ))}
      {failureLine}
    </FieldGroup>
  );
};

/**
 * The prompt that asks for a fresh sign-in, opened when the server refuses an action for a stale
 * session. An account with a password answers with it; an account without one signs in again with
 * a linked provider. Either makes the session fresh, then `onDone` retries the refused action.
 *
 * @param props - The prompt's props.
 * @param props.email - The email of the signed-in account.
 * @param props.open - Whether the prompt shows.
 * @param props.onDone - Called after the session is fresh again.
 * @param props.onCancel - Called when the prompt is dismissed.
 * @returns The dialog.
 */
export const Reauthenticate = ({
  email,
  onCancel,
  onDone,
  open,
}: {
  readonly email: string;
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}) => {
  const [providers, setProviders] = useState<ReadonlyArray<string>>([]);

  useEffect(() => {
    if (open) {
      void run(
        betterAuthCall(() => authClient.listAccounts()).pipe(
          Effect.match({
            onFailure: (): ReadonlyArray<string> => [],
            onSuccess: (data) => reauthProviders(decodeAccounts(data)),
          }),
          Effect.tap((offered) =>
            Effect.sync(() => {
              setProviders(offered);
            }),
          ),
        ),
      );
    }
  }, [open]);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it&apos;s you</DialogTitle>
          <DialogDescription>
            {providers.length === 0
              ? "Enter your password to continue."
              : "You have no password. Sign in again to continue."}
          </DialogDescription>
        </DialogHeader>
        <Answers email={email} onDone={onDone} providers={providers} />
      </DialogContent>
    </Dialog>
  );
};
