import { Schema } from "effect";

/**
 * The failure of repository resolution: neither `GITHUB_REPOSITORY` nor the `origin` remote names
 * an `owner/repo`.
 */
export class RepositoryError extends Schema.TaggedError<
  RepositoryError,
  { readonly brand: unique symbol }
>()("RepositoryError", {
  message: Schema.String,
}) {}

/**
 * The refusal of the admin guard: the repository is unreadable or the token lacks
 * `permissions.admin`. Nothing may be written after it.
 */
export class AdminGuardError extends Schema.TaggedError<
  AdminGuardError,
  { readonly brand: unique symbol }
>()("AdminGuardError", {
  message: Schema.String,
}) {}

/**
 * The refusal of {@link refuseAmbientCredentials}: an environment variable could make the
 * `@alchemy.run/github` provider authenticate as, or talk to, something the admin guard never
 * checked.
 */
export class AmbientCredentialsError extends Schema.TaggedError<
  AmbientCredentialsError,
  { readonly brand: unique symbol }
>()("AmbientCredentialsError", { message: Schema.String }) {}
