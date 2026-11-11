import { Effect, Option, Schema } from "effect";
import type { AuthErrorInput } from "./auth-error-copy.ts";
import type { authClient } from "./auth-client.ts";

/**
 * The code Better Auth answers with when a sensitive action needs a fresher session. The server
 * decides this; the client never measures the session's age.
 */
export const FRESH_SESSION_CODE = "SESSION_NOT_FRESH";

/**
 * The browser auth client as far as the settings calls use it.
 */
export type SettingsClient = typeof authClient;

/**
 * What an auth client call settles with: `error` is set when the call failed.
 */
export interface Settled {
  readonly data?: unknown;
  readonly error: AuthErrorInput["error"];
}

/**
 * Whether a failed call is the server's refusal for a stale session, which opens the
 * re-authentication prompt.
 *
 * @param error - The `error` of a settled call.
 * @returns `true` for the fresh-session refusal.
 */
export const needsFreshSession = (error: Settled["error"]): boolean =>
  error?.code === FRESH_SESSION_CODE;

/**
 * Runs an auth client call as an effect that never fails: a call that rejects before any response
 * settles as status 0.
 *
 * @param call - The client call.
 * @returns The effect of the call's settled result.
 */
export const settle = (call: () => PromiseLike<Settled>): Effect.Effect<Settled> =>
  Effect.tryPromise({ catch: (cause) => cause, try: call }).pipe(
    Effect.orElseSucceed((): Settled => ({ error: { status: 0 } })),
  );

/**
 * The calls of the settings screen, one per action. Each goes through the `/auth/*` forward: the
 * client resolves its paths against the page's own origin.
 *
 * @param client - The browser auth client.
 * @returns One function per action.
 */
export const settingsCalls = (client: SettingsClient) => ({
  addPasskey: (name: string) => client.passkey.addPasskey({ name }),
  changePassword: (currentPassword: string, newPassword: string, revokeOtherSessions: boolean) =>
    client.changePassword({ currentPassword, newPassword, revokeOtherSessions }),
  deletePasskey: (id: string) =>
    client.$fetch("/passkey/delete-passkey", { body: { id }, method: "POST" }),
  linkProvider: (provider: string) =>
    client.linkSocial({ callbackURL: "/settings", errorCallbackURL: "/settings", provider }),
  listAccounts: () => client.listAccounts(),
  listPasskeys: () => client.$fetch("/passkey/list-user-passkeys", { method: "GET" }),
  renamePasskey: (id: string, name: string) =>
    client.$fetch("/passkey/update-passkey", { body: { id, name }, method: "POST" }),
  unlinkAccount: (accountId: string) => client.unlinkAccount({ accountId }),
  updateProfile: (name: string, image: string) =>
    client.updateUser({ image: image === "" ? null : image, name }),
});

/**
 * The provider id Better Auth gives the email and password account.
 */
const CREDENTIAL_PROVIDER = "credential";

const Accounts = Schema.Array(Schema.Struct({ id: Schema.String, providerId: Schema.String }));

/**
 * Decodes the `data` of the account list call.
 */
export const decodeAccounts = Schema.decodeUnknownOption(Accounts);

/**
 * Decodes the `data` of the passkey list call. A passkey added with no name has a null name.
 */
export const decodePasskeys = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
);

/**
 * The label of a passkey added with no name.
 */
export const PASSKEY_FALLBACK_NAME = "Unnamed passkey";

/**
 * The line under the Passkeys heading, shown only when email is off, because then a passkey is the
 * way back in.
 *
 * @param emailLive - Whether email is on.
 * @returns The line, or `null` when email is on.
 */
export const passkeyHint = (emailLive: boolean): string | null =>
  emailLive ? null : "Without email, a passkey is the way back in if the password is forgotten.";

/**
 * The providers to offer for signing in again. An account with a password, or a list that cannot
 * be read, offers none: the password form is the answer.
 *
 * @param decoded - The decoded account list.
 * @returns The linked providers when the account has no password, otherwise none.
 */
export const reauthProviders = (
  decoded: Option.Option<typeof Accounts.Type>,
): readonly string[] => {
  const accounts = Option.getOrElse(decoded, () => []);

  return accounts.some(({ providerId }) => providerId === CREDENTIAL_PROVIDER)
    ? []
    : accounts.map(({ providerId }) => providerId);
};

const PROVIDER_NAMES = new Map([
  ["github", "GitHub"],
  ["google", "Google"],
]);

/**
 * The name a person knows a provider by.
 *
 * @param provider - The provider id.
 * @returns The display name, or the id for a provider without one.
 */
export const providerName = (provider: string): string => PROVIDER_NAMES.get(provider) ?? provider;
