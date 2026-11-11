import { passkey } from "@better-auth/passkey";
import { Option } from "effect";

/**
 * The relying-party id of an origin: its host name, which a passkey is bound to.
 *
 * @param origin - The validated public origin.
 * @returns The host name, or `localhost` for text that does not parse, which the origin schema has
 *   already ruled out.
 */
const relyingPartyId = (origin: string): string =>
  Option.fromNullishOr(URL.parse(origin)).pipe(
    Option.map((url) => url.hostname),
    Option.getOrElse(() => "localhost"),
  );

/**
 * The options of the passkey plugin for one public origin: a resident key and user verification are
 * both required, and the relying-party id and the accepted origin come from `PUBLIC_ORIGIN`.
 *
 * @param origin - The validated `PUBLIC_ORIGIN`.
 * @returns The plugin options.
 */
export const passkeyOptions = (origin: string) =>
  ({
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    origin,
    rpID: relyingPartyId(origin),
  }) as const;

/**
 * The passkey plugin for one public origin, built from {@link passkeyOptions}.
 *
 * @param origin - The validated `PUBLIC_ORIGIN`.
 * @returns The plugin to register in the Better Auth `plugins` list.
 */
export const passkeyPlugin = (origin: string) => passkey(passkeyOptions(origin));
