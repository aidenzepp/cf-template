import { Schema } from "effect";

/**
 * Identifier of a signed-in user.
 */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));

/**
 * The session shared by `auth`, `api` and `web`, with the display fields the shell renders.
 * `image` is the one nullable field: the user record has no image until one is set.
 */
export class Session extends Schema.Class<Session>("Session")({
  email: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
  image: Schema.NullOr(Schema.String),
  name: Schema.String,
  userId: UserId,
}) {}
