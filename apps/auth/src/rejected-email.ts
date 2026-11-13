import { createAuthMiddleware, isAPIError } from "better-auth/api";
import type { Redacted } from "effect";
import { Effect, Option, Predicate, Schema } from "effect";
import { EMAIL_KEY_FIELD, emailKey } from "./email-key.ts";
import type { RunEffect } from "./password.ts";

/**
 * The paths whose rejection is logged: the two that take an address and a password.
 */
const EMAIL_PATHS = new Set(["/sign-in/email", "/sign-up/email"]);

/**
 * The part of the body this hook reads.
 */
const EmailBody = Schema.Struct({ email: Schema.String });

/**
 * What the hook needs from one execution.
 */
export interface RejectedEmailOptions {
  /**
   * Runs an effect with the services the instance was built under.
   */
  readonly run: RunEffect;
  /**
   * The secret bound as `EMAIL_KEY_SECRET`. Without it the line carries no key.
   */
  readonly secret: Option.Option<Redacted.Redacted>;
}

/**
 * The `hooks.after` middleware that makes a rejected sign-in or sign-up traceable to the address
 * that was submitted, before any user id exists.
 *
 * When Better Auth answers `/sign-in/email` or `/sign-up/email` with an error, such as a duplicate
 * sign-up or a wrong password, the hook logs one `auth.email.rejected` line. The line carries the
 * Better Auth error `code`, the `path` and the {@link EMAIL_KEY_FIELD} hash of the address, and
 * never the address. A failure of the hash is logged by name only, and the response is untouched.
 *
 * @param options - The effect runner and the secret.
 * @returns The middleware to register as `hooks.after`.
 */
export const logRejectedEmail = (options: RejectedEmailOptions) =>
  createAuthMiddleware(async (ctx) => {
    const { returned } = ctx.context;
    const body = Schema.decodeUnknownOption(EmailBody)(ctx.body);

    if (!EMAIL_PATHS.has(ctx.path) || !isAPIError(returned) || Option.isNone(body)) {
      return;
    }

    const code = Predicate.hasProperty(returned.body, "code") ? String(returned.body.code) : "none";
    const { email } = body.value;

    const rejected = (fields: Record<string, string>) =>
      Effect.logInfo("auth.email.rejected").pipe(
        Effect.annotateLogs({ ...fields, code, path: ctx.path }),
      );

    await options.run(
      Option.match(options.secret, {
        onNone: () => rejected({}),
        // Only a value that looks like an address is hashed, so a password typed into the field is not.
        onSome: (secret) =>
          email.includes("@")
            ? emailKey(secret, email).pipe(
                Effect.flatMap((key) => rejected({ [EMAIL_KEY_FIELD]: key })),
                Effect.catchCause(() => Effect.logWarning("auth.email_key.failed")),
              )
            : rejected({}),
      }),
    );
  });
