import { Predicate, Schema } from "effect";
import { STEP_1 } from "./runbook.ts";

/**
 * A refusal or failure of the credentials half. The message names the runbook step in
 * `docs/spin-up.md` and never a token, a profile's contents or a secret value.
 */
export class CredentialsError extends Schema.TaggedError<
  CredentialsError,
  { readonly brand: unique symbol }
>()("CredentialsError", {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

/**
 * Wrap a failed step as a {@link CredentialsError} naming its tag and message, never its request.
 *
 * @param step - What failed.
 * @returns The mapper.
 */
export const failed = (step: string) => (cause: unknown) =>
  new CredentialsError({
    cause,
    message: `${step} failed${Predicate.hasProperty(cause, "_tag") ? ` (${String(cause._tag)})` : ""}. If the admin token expired, re-mint it with \`bun run alchemy profile edit --profile admin\` and run again. ${STEP_1}`,
  });
