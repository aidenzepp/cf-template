import { scrypt, timingSafeEqual } from "node:crypto";
import type { BinaryLike, ScryptOptions } from "node:crypto";
import { promisify } from "node:util";
import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { Context, Effect, Option, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { ScryptParams, scryptMaxmem } from "@workspace/config/auth-password";
import type { ScryptCost } from "@workspace/config/auth-password";

/**
 * Runs an Effect with the services of the request that built the instance and settles with its
 * value, as `Effect.runPromiseWith(services)` does.
 */
export type RunEffect = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/**
 * The stored hash parsed into its parts.
 */
export interface ParsedHash {
  readonly params: ScryptCost;
  readonly salt: Uint8Array;
  readonly key: Uint8Array;
}

/**
 * The failure of one scrypt derivation.
 */
export class ScryptError extends Schema.TaggedError<
  ScryptError,
  { readonly brand: unique symbol }
>()("ScryptError", {
  cause: Schema.Unknown,
  keyLength: Schema.Int,
}) {
  override get message(): string {
    return `scrypt could not derive a ${this.keyLength}-byte key.`;
  }
}

/**
 * The failure of one call to the Better Auth adapter while rehashing a password.
 */
class RehashAdapterError extends Schema.TaggedError<
  RehashAdapterError,
  { readonly brand: unique symbol }
>()("RehashAdapterError", {
  cause: Schema.Defect(),
}) {}

/**
 * The bytes of the random salt.
 */
const SALT_BYTES = 16;

/**
 * The bytes of the derived key.
 */
const KEY_BYTES = 64;

/**
 * The shape of a stored hash's cost segment, `ln=15,r=8,p=3`.
 */
const COST_SEGMENT = /^ln=(?<ln>\d{1,2}),r=(?<r>\d{1,2}),p=(?<p>\d{1,2})$/u;

/**
 * The shape of unpadded standard base64.
 */
const UNPADDED_BASE64 = /^[A-Za-z0-9+/]*$/u;

/**
 * Node's callback scrypt as a Promise, typed with the options overload.
 */
const scryptAsync: (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer> = promisify(scrypt);

/**
 * The port through which this module derives a scrypt key.
 */
export interface ScryptPort {
  /**
   * Derive a key of `length` bytes from the NFKC-normalized password.
   */
  readonly derive: (
    password: string,
    salt: Uint8Array,
    params: ScryptCost,
    length: number,
  ) => Effect.Effect<Uint8Array, ScryptError>;
}

/**
 * Derive a scrypt key with `node:crypto`, the project's one scrypt call. Effect has no scrypt (its
 * `Kdf` is PBKDF2 only) and Workers serve it only through `node:crypto` under `nodejs_compat`.
 *
 * @param password - The NFKC-normalized password.
 * @param salt - The salt bytes.
 * @param params - The cost parameters.
 * @param length - The derived key length in bytes.
 * @returns The derived key.
 */
const nodeDerive: ScryptPort["derive"] = (password, salt, params, length) =>
  Effect.tryPromise({
    catch: (cause) => new ScryptError({ cause, keyLength: length }),
    try: () =>
      scryptAsync(password, salt, length, {
        N: 2 ** params.ln,
        maxmem: scryptMaxmem(params),
        p: params.p,
        r: params.r,
      }),
  });

/**
 * The scrypt port. It defaults to `node:crypto`; a test provides a counting implementation to
 * prove a hash is refused before any derivation starts.
 */
export const Scrypt = Context.Reference<ScryptPort>("@workspace/auth/Scrypt", {
  defaultValue: () => ({ derive: nodeDerive }),
});

/**
 * Derive a key through the {@link Scrypt} port.
 *
 * @param password - The NFKC-normalized password.
 * @param salt - The salt bytes.
 * @param params - The cost parameters.
 * @param length - The derived key length in bytes.
 * @returns The derived key.
 */
const derive = Effect.fn("auth.derive")(function* derive(
  password: string,
  salt: Uint8Array,
  params: ScryptCost,
  length: number,
) {
  const port = yield* Scrypt;

  return yield* port.derive(password, salt, params, length);
});

/**
 * Encode bytes as unpadded standard base64.
 *
 * @param bytes - The bytes.
 * @returns The text without `=` padding.
 */
const encode = (bytes: Uint8Array): string => Base64.encode(bytes).replace(/[=]+$/u, "");

/**
 * Decode canonical unpadded standard base64.
 *
 * @param text - The text.
 * @returns The bytes, or none when the text is padded, not base64 or not canonical.
 */
const decode = (text: string): Option.Option<Uint8Array> => {
  if (!UNPADDED_BASE64.test(text) || text.length % 4 === 1) {
    return Option.none();
  }

  const decoded = Base64.decode(text.padEnd(Math.ceil(text.length / 4) * 4, "="));

  return Result.isSuccess(decoded) && encode(decoded.success) === text
    ? Option.some(decoded.success)
    : Option.none();
};

/**
 * Parse a stored hash, `$scrypt$ln=<ln>,r=<r>,p=<p>$<salt>$<key>`.
 *
 * The parameters decode with the bounds and the memory and work ceilings of `ScryptParams`, never
 * the floors, so a hash stored under a lower cost still verifies. A `salt:key` string, a wrong salt
 * or key length and any other shape yield none.
 *
 * @param stored - The stored hash.
 * @returns The parts, or none when the string is not a hash this module wrote.
 */
export const parse = (stored: string): Option.Option<ParsedHash> => {
  const [empty, scheme, cost, salt, key, ...rest] = stored.split("$");
  const match = COST_SEGMENT.exec(cost ?? "")?.groups;

  if (empty !== "" || scheme !== "scrypt" || rest.length > 0 || match === undefined) {
    return Option.none();
  }

  return Option.all({
    key: decode(key ?? "").pipe(Option.filter((bytes) => bytes.length === KEY_BYTES)),
    params: Schema.decodeOption(ScryptParams)({
      ln: Number(match.ln),
      p: Number(match.p),
      r: Number(match.r),
    }),
    salt: decode(salt ?? "").pipe(Option.filter((bytes) => bytes.length === SALT_BYTES)),
  });
};

/**
 * Report whether a stored hash was made under a cost other than `params`.
 *
 * @param stored - The stored hash.
 * @param params - The knob's current value.
 * @returns `true` for a parsed hash whose `(ln, r, p)` differs; `false` for a match or for a
 *   string that is not a hash.
 */
export const needsRehash = (stored: string, params: ScryptCost): boolean =>
  Option.exists(
    parse(stored),
    (parsed) =>
      parsed.params.ln !== params.ln ||
      parsed.params.r !== params.r ||
      parsed.params.p !== params.p,
  );

/**
 * The effect of hashing a password under `params` with a fresh random salt.
 *
 * @param params - The cost parameters.
 * @param password - The plaintext password.
 * @returns The stored hash.
 */
export const hashEffect = (params: ScryptCost, password: string) =>
  Effect.gen(function* hashPassword() {
    const salt = yield* Effect.sync(() => crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
    const key = yield* derive(password.normalize("NFKC"), salt, params, KEY_BYTES);

    return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${encode(salt)}$${encode(key)}`;
  });

/**
 * The effect of checking a password against a stored hash.
 *
 * A malformed or legacy string logs `auth.password.malformed` and answers `false` before any scrypt
 * call; a failed derivation logs `auth.password.verify_failed` and answers `false`. The comparison
 * is constant-time and runs only on equal lengths.
 *
 * @param input - The stored hash and the candidate password.
 * @returns Whether the password matches.
 */
export const verifyEffect = (input: { readonly hash: string; readonly password: string }) =>
  Effect.gen(function* verifyPassword() {
    const parsed = parse(input.hash);

    if (Option.isNone(parsed)) {
      yield* Effect.logWarning("auth.password.malformed");

      return false;
    }

    const { key, params, salt } = parsed.value;

    const derived = yield* derive(input.password.normalize("NFKC"), salt, params, key.length).pipe(
      Effect.asSome,
      Effect.catchTag("ScryptError", () =>
        Effect.logWarning("auth.password.verify_failed").pipe(Effect.as(Option.none())),
      ),
    );

    return (
      Option.isSome(derived) &&
      derived.value.length === key.length &&
      timingSafeEqual(derived.value, key)
    );
  });

/**
 * The Better Auth `password.hash` and `password.verify` options over a runner.
 *
 * @param params - The knob's current value, the cost of every new hash.
 * @param run - Runs an effect with the captured services.
 * @returns The two Promise adapters.
 */
export const passwordFor = (params: ScryptCost, run: RunEffect) => ({
  hash: (password: string): Promise<string> => run(hashEffect(params, password)),
  verify: (input: { hash: string; password: string }): Promise<boolean> => run(verifyEffect(input)),
});

/**
 * The sign-in body the rehash reads: the plaintext password Better Auth has just verified.
 */
const SignInBody = Schema.Struct({ password: Schema.String });

/**
 * A Better Auth plugin whose `hooks.after` on `/sign-in/email` rewrites the signed-in user's
 * credential hash when its cost differs from `params`.
 *
 * Better Auth `1.7.19` runs plugin `hooks.after` entries whose `matcher` accepts the endpoint
 * context (`node_modules/better-auth/dist/api/dispatch.mjs`, `getHooks`), and `ctx.body` still
 * carries the plaintext password there. A failed rewrite logs `auth.password.rehash_failed` and
 * never fails the sign-in.
 *
 * @param params - The knob's current value.
 * @param run - Runs an effect with the captured services.
 * @returns The plugin.
 */
export const rehashAfterSignIn = (params: ScryptCost, run: RunEffect): BetterAuthPlugin => ({
  hooks: {
    after: [
      {
        handler: createAuthMiddleware(async (ctx) => {
          const userId = ctx.context.newSession?.user.id;
          const body = Schema.decodeUnknownOption(SignInBody)(ctx.body);

          if (userId === undefined || Option.isNone(body)) {
            return;
          }

          await run(
            Effect.gen(function* rehash() {
              const account = yield* Effect.tryPromise({
                catch: (cause) => new RehashAdapterError({ cause }),
                try: () => ctx.context.internalAdapter.findCredentialAccount(userId),
              });

              const stored = account?.password;

              if (
                account === null ||
                account === undefined ||
                stored === undefined ||
                stored === null ||
                !needsRehash(stored, params)
              ) {
                return;
              }

              const replacement = yield* hashEffect(params, body.value.password);

              // Compare-and-set: only the row still holding the hash just verified is rewritten, so a
              // password changed meanwhile is never reverted.
              yield* Effect.tryPromise({
                catch: (cause) => new RehashAdapterError({ cause }),
                try: () =>
                  ctx.context.adapter.updateMany({
                    model: "account",
                    update: { password: replacement },
                    where: [
                      { field: "id", value: account.id },
                      { field: "password", value: stored },
                    ],
                  }),
              });
            }).pipe(Effect.catchCause(() => Effect.logWarning("auth.password.rehash_failed"))),
          );
        }),
        matcher: (ctx) => ctx.path === "/sign-in/email",
      },
    ],
  },
  id: "rehash-after-sign-in",
});
