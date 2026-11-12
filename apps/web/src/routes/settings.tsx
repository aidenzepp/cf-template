import { createFileRoute, useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/ui/alert";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import { Field, FieldError, FieldGroup } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { Effect, Option, Schema } from "effect";
import { useEffect, useState } from "react";
import { Reauthenticate } from "../components/auth/reauthenticate.tsx";
import { focusFirstInvalid, formValidator, useAppForm } from "../components/form/form-hook.tsx";
import { AppearanceCard } from "../components/settings/appearance-card.tsx";
import { DeveloperCard } from "../components/settings/developer-card.tsx";
import { SettingsPanel, SettingsTabs } from "../components/settings/settings-tabs.tsx";
import { authClient } from "../lib/auth-client.ts";
import { authErrorCopy } from "../lib/auth-error-copy.ts";
import { betterAuthCall } from "../lib/better-auth-call.ts";
import type { Settled } from "../lib/better-auth-call.ts";
import { oauthErrorCode, oauthErrorCopy } from "../lib/oauth-error-copy.ts";
import { settingsTab } from "../lib/settings-tab.ts";
import {
  PASSKEY_FALLBACK_NAME,
  decodeAccounts,
  decodePasskeys,
  passkeyHint,
  providerName,
  settingsCalls,
} from "../lib/settings-calls.ts";
import { run as runEffect } from "../runtime.ts";
import { actionAtom, useAction } from "./-settings-action.ts";

const calls = settingsCalls(authClient);

/**
 * The fields of the profile form. The image is optional; when it is there it is a web address.
 */
const ProfileInput = Schema.Struct({
  image: Schema.String.check(
    Schema.isPattern(/^(?:https?:\/\/\S+)?$/u, {
      message: "Enter a web address that starts with https://.",
    }),
  ),
  name: Schema.String.check(Schema.isNonEmpty({ message: "Enter your name." })),
});

/**
 * The fields of the password form. Better Auth owns the rules of the new password.
 */
const PasswordInput = Schema.Struct({
  current: Schema.String.check(Schema.isNonEmpty({ message: "Enter your current password." })),
  next: Schema.String.check(Schema.isNonEmpty({ message: "Enter a new password." })),
  revoke: Schema.Boolean,
});

const NO_ITEMS: ReadonlyArray<never> = [];

const profileAtom = actionAtom();

const passwordAtom = actionAtom();

const passkeysAtom = actionAtom();

const accountsAtom = actionAtom();

/**
 * Loads a list when the card mounts and again after `reload`. A failed load leaves the list empty
 * and keeps the error line to show.
 *
 * @param call - Reads the list.
 * @param decode - Decodes the list from the call's data.
 * @returns The list, the error line of a failed load, and `reload`.
 */
const useLoaded = <Item,>(
  call: () => PromiseLike<Settled>,
  decode: (data: Settled["data"]) => Option.Option<ReadonlyArray<Item>>,
) => {
  const [items, setItems] = useState<ReadonlyArray<Item>>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let current = true;

    void runEffect(
      betterAuthCall(call).pipe(
        Effect.map(decode),
        Effect.match({
          onFailure: ({ error }) => ({
            failure: authErrorCopy({ aborted: false, error }),
            items: NO_ITEMS,
          }),
          onSuccess: (list) => ({
            failure: authErrorCopy({
              aborted: false,
              error: Option.isNone(list) ? { status: 500 } : null,
            }),
            items: Option.getOrElse(list, (): ReadonlyArray<Item> => []),
          }),
        }),
        Effect.tap((loaded) =>
          Effect.sync(() => {
            if (current) {
              setItems(loaded.items);
              setFailure(loaded.failure);
            }
          }),
        ),
      ),
    );

    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reloads is the Reload trigger: bumping it reruns the effect; the effect intentionally does not read it
  }, [call, decode, reloads]);

  return {
    failure,
    items,
    reload: () => {
      setReloads((count) => count + 1);
    },
  };
};

const ProfileCard = ({
  askFresh,
  image,
  name,
}: {
  readonly askFresh: (retry: () => void) => void;
  readonly image: string | null;
  readonly name: string;
}) => {
  const { act } = useAction(profileAtom, askFresh);

  const form = useAppForm({
    defaultValues: { image: image ?? "", name },
    onSubmit: ({ value }) =>
      act({
        call: () => calls.updateProfile(value.name, value.image),
        done: "Profile saved.",
        failed: "Could not save your profile.",
      }),
    onSubmitInvalid: focusFirstInvalid,
    validators: { onSubmit: formValidator(ProfileInput) },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.AppField name="name">
              {(field) => <field.TextField label="Name" required type="text" />}
            </form.AppField>
            <form.AppField name="image">
              {(field) => <field.TextField label="Image URL" type="url" />}
            </form.AppField>
            <form.AppForm>
              <form.SubmitButton>Save profile</form.SubmitButton>
            </form.AppForm>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
};

const PasswordCard = ({ askFresh }: { readonly askFresh: (retry: () => void) => void }) => {
  const { act } = useAction(passwordAtom, askFresh);

  const form = useAppForm({
    defaultValues: { current: "", next: "", revoke: true },
    onSubmit: ({ formApi, value }) =>
      act(
        {
          call: () => calls.changePassword(value.current, value.next, value.revoke),
          done: "Password changed.",
          failed: "Could not change your password.",
        },
        () => {
          formApi.reset();
        },
      ),
    onSubmitInvalid: focusFirstInvalid,
    validators: { onSubmit: formValidator(PasswordInput) },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.AppField name="current">
              {(field) => (
                <field.TextField
                  autoComplete="current-password"
                  label="Current password"
                  required
                  type="password"
                />
              )}
            </form.AppField>
            <form.AppField name="next">
              {(field) => (
                <field.TextField
                  autoComplete="new-password"
                  label="New password"
                  required
                  type="password"
                />
              )}
            </form.AppField>
            <form.AppField name="revoke">
              {(field) => <field.CheckboxField label="Sign out other devices" />}
            </form.AppField>
            <form.AppForm>
              <form.SubmitButton>Change password</form.SubmitButton>
            </form.AppForm>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
};

const PasskeyRow = ({
  act,
  id,
  name,
  pending,
  reload,
}: {
  readonly act: ReturnType<typeof useAction>["act"];
  readonly id: string;
  readonly name: string;
  readonly pending: boolean;
  readonly reload: () => void;
}) => {
  const form = useAppForm({
    defaultValues: { name },
    onSubmit: ({ value }) =>
      act(
        {
          call: () => calls.renamePasskey(id, value.name),
          done: "Passkey renamed.",
          failed: "Could not rename the passkey.",
        },
        reload,
      ),
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <Field orientation="horizontal">
        <form.Field name="name">
          {(field) => (
            <Input
              aria-label="Passkey name"
              name="name"
              onBlur={field.handleBlur}
              onChange={(event) => {
                field.handleChange(event.target.value);
              }}
              required
              type="text"
              value={field.state.value}
            />
          )}
        </form.Field>
        <Button disabled={pending} type="submit" variant="outline">
          Rename
        </Button>
        <Button
          disabled={pending}
          onClick={() => {
            void act(
              {
                call: () => calls.deletePasskey(id),
                done: "Passkey deleted.",
                failed: "Could not delete the passkey.",
              },
              reload,
            );
          }}
          type="button"
          variant="outline"
        >
          Delete
        </Button>
      </Field>
    </form>
  );
};

const PasskeysCard = ({
  askFresh,
  emailLive,
}: {
  readonly askFresh: (retry: () => void) => void;
  readonly emailLive: boolean;
}) => {
  const { act, pending } = useAction(passkeysAtom, askFresh);
  const { failure, items: passkeys, reload } = useLoaded(calls.listPasskeys, decodePasskeys);
  const hint = passkeyHint(emailLive);

  const form = useAppForm({
    defaultValues: { name: "" },
    onSubmit: ({ formApi, value }) =>
      act(
        {
          call: () => calls.addPasskey(value.name),
          done: "Passkey added.",
          failed: "Could not add the passkey.",
        },
        () => {
          formApi.reset();
          reload();
        },
      ),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        {hint === null ? null : <CardDescription>{hint}</CardDescription>}
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {passkeys.map((passkey) => (
            <PasskeyRow
              act={act}
              id={passkey.id}
              key={passkey.id}
              name={passkey.name ?? PASSKEY_FALLBACK_NAME}
              pending={pending}
              reload={reload}
            />
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <Field orientation="horizontal">
              <form.Field name="name">
                {(field) => (
                  <Input
                    aria-label="New passkey name"
                    name="name"
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      field.handleChange(event.target.value);
                    }}
                    placeholder="Name"
                    type="text"
                    value={field.state.value}
                  />
                )}
              </form.Field>
              <Button disabled={pending} type="submit">
                Add passkey
              </Button>
            </Field>
          </form>
          <FieldError>{failure}</FieldError>
        </FieldGroup>
      </CardContent>
    </Card>
  );
};

const AccountsCard = ({
  askFresh,
  providers,
}: {
  readonly askFresh: (retry: () => void) => void;
  readonly providers: ReadonlyArray<string>;
}) => {
  const { act, pending } = useAction(accountsAtom, askFresh);
  const { failure, items: accounts, reload } = useLoaded(calls.listAccounts, decodeAccounts);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected accounts</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {providers.map((provider) => {
            const name = providerName(provider);
            const account = accounts.find(({ providerId }) => providerId === provider);

            return account === undefined ? (
              <Button
                disabled={pending}
                key={provider}
                onClick={() => {
                  void act({
                    call: () => calls.linkProvider(provider),
                    done: `Opening ${name}.`,
                    failed: `Could not link ${name}.`,
                  });
                }}
                type="button"
                variant="outline"
              >
                {`Link ${name}`}
              </Button>
            ) : (
              <Button
                disabled={pending}
                key={provider}
                onClick={() => {
                  void act(
                    {
                      call: () => calls.unlinkAccount(account.id),
                      done: `${name} unlinked.`,
                      failed: `Could not unlink ${name}.`,
                    },
                    reload,
                  );
                }}
                type="button"
                variant="outline"
              >
                {`Unlink ${name}`}
              </Button>
            );
          })}
          <FieldError>{failure}</FieldError>
        </FieldGroup>
      </CardContent>
    </Card>
  );
};

/**
 * The account settings screen. The root guard keeps a signed-out caller out; a stale session is
 * answered by the server, and the prompt asks for the password again.
 *
 * @returns The page body.
 */
const Settings = () => {
  const { authMethods, session } = useRouteContext({ from: "/settings" });
  const { error, tab = "preferences" } = useSearch({ from: "/settings" });
  const navigate = useNavigate({ from: "/settings" });
  const [retry, setRetry] = useState<(() => void) | undefined>(undefined);

  if (session._tag !== "signedIn") {
    return null;
  }

  const askFresh = (next: () => void) => {
    setRetry(() => next);
  };

  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{oauthErrorCopy(error)}</AlertDescription>
        </Alert>
      )}
      <SettingsTabs
        onTabChange={(next) => {
          void navigate({ search: (previous) => ({ ...previous, tab: next }) });
        }}
        tab={tab}
      >
        <SettingsPanel tab="preferences">
          <AppearanceCard />
        </SettingsPanel>
        <SettingsPanel tab="account">
          <ProfileCard
            askFresh={askFresh}
            image={session.session.image}
            name={session.session.name}
          />
          <PasswordCard askFresh={askFresh} />
          <PasskeysCard askFresh={askFresh} emailLive={authMethods.email} />
          <AccountsCard askFresh={askFresh} providers={authMethods.providers} />
        </SettingsPanel>
        <SettingsPanel tab="developer">
          <DeveloperCard />
        </SettingsPanel>
      </SettingsTabs>
      <Reauthenticate
        email={session.session.email}
        onCancel={() => {
          setRetry(undefined);
        }}
        onDone={() => {
          retry?.();
          setRetry(undefined);
        }}
        open={retry !== undefined}
      />
    </main>
  );
};

export const Route = createFileRoute("/settings")({
  component: Settings,
  // The same allowlist as `/oauth-error`: only a known code reaches the page or the address bar. The
  // tab is the selected tab, so a reload or a link opens it; the first tab has no value.
  search: { middlewares: [({ search }) => ({ error: search.error, tab: search.tab })] },
  staticData: { nav: { label: "Settings", order: 20 } },
  validateSearch: (search: { readonly error?: unknown; readonly tab?: unknown }) => ({
    error: oauthErrorCode(search.error),
    tab: settingsTab(search.tab),
  }),
});
