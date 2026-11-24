import { Context, Schema } from "effect";
import type { Effect } from "effect";

/**
 * A zone, by id and name.
 */
export interface ZoneRef {
  readonly id: string;
  readonly name: string;
}

/**
 * One rule of a zone's `http_ratelimit` entrypoint, as the guard reads it: Cloudflare's id and the
 * `ref` the rule was written with, if any.
 */
export interface EntrypointRule {
  readonly id: string;
  readonly ref: string | undefined;
}

/**
 * The zone that holds a hostname and the rules of its `http_ratelimit` entrypoint. An absent
 * entrypoint reads as no rules.
 */
interface ZoneEntrypoint {
  readonly zone: ZoneRef;
  readonly rules: ReadonlyArray<EntrypointRule>;
}

/**
 * The failure of a Cloudflare call the guard made, or of a zone it could not find. Its message says
 * the deploy was refused and what the credentials need.
 */
export class RateLimitEntrypointError extends Schema.TaggedError<
  RateLimitEntrypointError,
  { readonly brand: unique symbol }
>()("RateLimitEntrypointError", { message: Schema.String }) {}

/**
 * The one read the guard makes. Tests provide a fake; `RateLimitEntrypointLive` provides the real
 * one.
 */
export class RateLimitEntrypoint extends Context.Service<
  RateLimitEntrypoint,
  {
    /**
     * The zone of `hostname` and the rules of its `http_ratelimit` entrypoint; `variable` names the
     * setting that supplied the hostname, for the error that asks for another.
     */
    readonly read: (
      hostname: string,
      variable: string,
    ) => Effect.Effect<ZoneEntrypoint, RateLimitEntrypointError>;
  }
>()("infra/RateLimitEntrypoint") {}
