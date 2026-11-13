import { Schema } from "effect";
import { Knob } from "@workspace/config/knob";

/**
 * The longest a signed cookie-cache entry may be trusted, in seconds. Better Auth's database
 * session lasts longer; the cache only decides how often `checkSession` re-reads it.
 */
const COOKIE_CACHE_MAX_AGE_CEILING_S = 900;

/**
 * How long, in seconds, the signed `session_data` cookie answers `checkSession` without a database
 * read. The schema caps it at {@link COOKIE_CACHE_MAX_AGE_CEILING_S}.
 */
export const CookieCacheMaxAgeKnob = Knob.make(
  "AUTH_COOKIE_CACHE_MAX_AGE_S",
  Schema.Int.pipe(
    Schema.check(Schema.isBetween({ maximum: COOKIE_CACHE_MAX_AGE_CEILING_S, minimum: 1 })),
  ).annotate({
    default: 300,
    description:
      "Seconds the signed session cookie cache answers a session check without a database read, 1 to 900.",
  }),
);

/**
 * How the signed `session_data` cookie encodes the cached session: `compact` (signed JSON), `jwt`
 * (signed token) or `jwe` (encrypted token).
 */
export const CookieCacheStrategyKnob = Knob.make(
  "AUTH_COOKIE_CACHE_STRATEGY",
  Schema.Literals(["compact", "jwt", "jwe"]).annotate({
    default: "compact",
    description: "How the signed session cookie cache encodes the cached session.",
  }),
);
