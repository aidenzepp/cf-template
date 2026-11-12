import { createFileRoute, useRouteContext, useSearch } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/ui/alert";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import { Checkbox } from "@workspace/ui/components/ui/checkbox";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { Effect, Option } from "effect";
import { useEffect, useState } from "react";
import { settingsOutcome } from "../components/auth/auth-outcome.ts";
import { Reauthenticate } from "../components/auth/reauthenticate.tsx";
import { useAction, useForm } from "../components/form/use-form.ts";
import { authClient } from "../lib/auth-client.ts";
import { authErrorCopy } from "../lib/auth-error-copy.ts";
import { oauthErrorCode, oauthErrorCopy } from "../lib/oauth-error-copy.ts";
import {
  PASSKEY_FALLBACK_NAME,
  decodeAccounts,
  decodePasskeys,
  passkeyHint,
  providerName,
  settingsCalls,
  settle,
} from "../lib/settings-calls.ts";
import type { Settled } from "../lib/settings-calls.ts";
import {
  NewPasskeyInput,
  PasskeyNameInput,
  PasswordInput,
  ProfileInput,
} from "../lib/settings-forms.ts";
import { fork, run as runEffect } from "../runtime.ts";

const calls = settingsCalls(authClient);

const passkeysOf = ({ data }: Settled) => decodePasskeys(data);

const accountsOf = ({ data }: Settled) => decodeAccounts(data);

/**
 * The cards' hand-off for a stale session: the prompt asks for the password, then runs the call
 * again.
 */
type AskFresh = (retry: () => void) => void;

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
  decode: (settled: Settled) => Option.Option<ReadonlyArray<Item>>,
) => {
  const [items, setItems] = useState<ReadonlyArray<Item>>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let current = true;

    void runEffect(
      settle(call).pipe(
        Effect.tap((settled) =>
          Effect.sync(() => {
            if (!current) {
              return;
            }

            const { error } = settled;
            const list = decode(settled);

            setItems(Option.getOrElse(list, () => []));
            setFailure(
              authErrorCopy({
                aborted: false,
                error: error ?? (Option.isNone(list) ? { status: 500 } : null),
              }),
            );
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
  readonly askFresh: AskFresh;
  readonly image: string | null;
  readonly name: string;
}) => {
  const { error, failure, field, formProps, pending } = useForm(
    ProfileInput,
    (values) =>
      settingsOutcome(() => calls.updateProfile(values.name, values.image), "Profile saved."),
    { fork, onPaused: askFresh },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form {...formProps}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="profile-name">Name</FieldLabel>
              <Input
                defaultValue={name}
                id="profile-name"
                name="name"
                required
                type="text"
                {...field("name")}
              />
              <FieldError {...error("name")} />
            </Field>
            <Field>
              <FieldLabel htmlFor="profile-image">Image URL</FieldLabel>
              <Input
                defaultValue={image ?? ""}
                id="profile-image"
                name="image"
                type="url"
                {...field("image")}
              />
              <FieldError {...error("image")} />
            </Field>
            <FieldError>{failure}</FieldError>
            <Button disabled={pending} type="submit">
              Save profile
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
};

const PasswordCard = ({ askFresh }: { readonly askFresh: AskFresh }) => {
  const { error, failure, field, formProps, pending } = useForm(
    PasswordInput,
    ({ current, next, revoke }) =>
      settingsOutcome(
        () => calls.changePassword(current, next, revoke !== undefined),
        "Password changed.",
      ),
    { fork, onPaused: askFresh },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form {...formProps}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="password-current">Current password</FieldLabel>
              <Input
                autoComplete="current-password"
                id="password-current"
                name="current"
                required
                type="password"
                {...field("current")}
              />
              <FieldError {...error("current")} />
            </Field>
            <Field>
              <FieldLabel htmlFor="password-next">New password</FieldLabel>
              <Input
                autoComplete="new-password"
                id="password-next"
                name="next"
                required
                type="password"
                {...field("next")}
              />
              <FieldError {...error("next")} />
            </Field>
            <Field orientation="horizontal">
              <Checkbox defaultChecked id="password-revoke" name="revoke" />
              <FieldLabel htmlFor="password-revoke">Sign out other devices</FieldLabel>
            </Field>
            <FieldError>{failure}</FieldError>
            <Button disabled={pending} type="submit">
              Change password
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
};

const PasskeyRow = ({
  askFresh,
  id,
  name,
  reload,
}: {
  readonly askFresh: AskFresh;
  readonly id: string;
  readonly name: string;
  readonly reload: () => void;
}) => {
  const options = { fork, onPaused: askFresh };

  const rename = useForm(
    PasskeyNameInput,
    (values) =>
      settingsOutcome(() => calls.renamePasskey(id, values.name), "Passkey renamed.", reload),
    options,
  );

  const remove = useAction(options);

  return (
    <form {...rename.formProps}>
      <Field orientation="horizontal">
        <Input
          aria-label="Passkey name"
          defaultValue={name}
          name="name"
          required
          type="text"
          {...rename.field("name")}
        />
        <Button disabled={rename.pending || remove.pending} type="submit" variant="outline">
          Rename
        </Button>
        <Button
          disabled={rename.pending || remove.pending}
          onClick={() => {
            remove.run(settingsOutcome(() => calls.deletePasskey(id), "Passkey deleted.", reload));
          }}
          type="button"
          variant="outline"
        >
          Delete
        </Button>
      </Field>
      <FieldError {...rename.error("name")} />
      <FieldError>{rename.failure ?? remove.failure}</FieldError>
    </form>
  );
};

const PasskeysCard = ({
  askFresh,
  emailLive,
}: {
  readonly askFresh: AskFresh;
  readonly emailLive: boolean;
}) => {
  const { failure, items: passkeys, reload } = useLoaded(calls.listPasskeys, passkeysOf);
  const hint = passkeyHint(emailLive);

  const add = useForm(
    NewPasskeyInput,
    (values) => settingsOutcome(() => calls.addPasskey(values.name), "Passkey added.", reload),
    { fork, onPaused: askFresh },
  );

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
              askFresh={askFresh}
              id={passkey.id}
              key={passkey.id}
              name={passkey.name ?? PASSKEY_FALLBACK_NAME}
              reload={reload}
            />
          ))}
          <form {...add.formProps}>
            <Field orientation="horizontal">
              <Input aria-label="New passkey name" name="name" placeholder="Name" type="text" />
              <Button disabled={add.pending} type="submit">
                Add passkey
              </Button>
            </Field>
          </form>
          <FieldError>{failure ?? add.failure}</FieldError>
        </FieldGroup>
      </CardContent>
    </Card>
  );
};

const AccountsCard = ({
  askFresh,
  providers,
}: {
  readonly askFresh: AskFresh;
  readonly providers: ReadonlyArray<string>;
}) => {
  const { failure: outcomeFailure, pending, run } = useAction({ fork, onPaused: askFresh });
  const { failure, items: accounts, reload } = useLoaded(calls.listAccounts, accountsOf);

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
                  run(settingsOutcome(() => calls.linkProvider(provider), undefined));
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
                  run(
                    settingsOutcome(
                      () => calls.unlinkAccount(account.id),
                      `${name} unlinked.`,
                      reload,
                    ),
                  );
                }}
                type="button"
                variant="outline"
              >
                {`Unlink ${name}`}
              </Button>
            );
          })}
          <FieldError>{failure ?? outcomeFailure}</FieldError>
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
  const { error } = useSearch({ from: "/settings" });
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
      <ProfileCard askFresh={askFresh} image={session.session.image} name={session.session.name} />
      <PasswordCard askFresh={askFresh} />
      <PasskeysCard askFresh={askFresh} emailLive={authMethods.email} />
      <AccountsCard askFresh={askFresh} providers={authMethods.providers} />
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
  // The same allowlist as `/oauth-error`: only a known code reaches the page or the address bar.
  search: { middlewares: [({ search }) => ({ error: search.error })] },
  staticData: { nav: { label: "Settings", order: 20 } },
  validateSearch: (search: { readonly error?: unknown }) => ({
    error: oauthErrorCode(search.error),
  }),
});
