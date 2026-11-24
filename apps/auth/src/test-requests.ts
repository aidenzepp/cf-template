import { Effect, Schema } from "effect";
import { AuthService } from "./auth.ts";
import { ORIGIN } from "./test-harness.ts";

/**
 * Send a request to the Better Auth handler.
 *
 * @param path - The path under `ORIGIN`, such as `/auth/sign-in/email`.
 * @param init - The request options.
 * @returns The handler's response.
 */
export const handle = Effect.fn("handle")(function* handle(path: string, init: RequestInit) {
  const instance = yield* (yield* yield* AuthService).auth;

  const headers = new Headers(init.headers);

  headers.set("content-type", "application/json");
  headers.set("origin", ORIGIN);

  return yield* Effect.promise(() =>
    instance.handler(new Request(`${ORIGIN}${path}`, { ...init, headers })),
  );
});

/**
 * Reduce a response's `Set-Cookie` headers to the `Cookie` header a browser would send back.
 *
 * @param response - A response that sets cookies.
 * @returns The `name=value` pairs joined for a `Cookie` header.
 */
export const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

/**
 * Drop the signed `session_data` cookie so a check cannot answer from the cookie cache and must
 * read the session row.
 *
 * @param cookie - A `Cookie` header from a sign-in.
 * @returns The header with only the other cookies.
 */
export const tokenOnly = (cookie: string) =>
  cookie
    .split("; ")
    .filter((pair) => !pair.includes("session_data"))
    .join("; ");

/**
 * The JSON text of a credential request body: the fields as written, in the order given.
 */
const CredentialBody = Schema.fromJsonString(
  Schema.Struct({
    email: Schema.String,
    name: Schema.optional(Schema.String),
    password: Schema.String,
  }),
);

/**
 * Sign up a user with an email and password and return the response.
 *
 * @param email - The new user's email.
 * @returns The sign-up response.
 */
export const signUp = (email: string) =>
  handle("/auth/sign-up/email", {
    body: Schema.encodeSync(CredentialBody)({
      email,
      name: "Ada Lovelace",
      password: "correct horse battery",
    }),
    method: "POST",
  });

/**
 * Sign in a user with an email and password and return the response.
 *
 * @param email - The user's email.
 * @returns The sign-in response, whose cookies carry the session.
 */
export const signIn = (email: string) =>
  handle("/auth/sign-in/email", {
    body: Schema.encodeSync(CredentialBody)({ email, password: "correct horse battery" }),
    method: "POST",
  });
