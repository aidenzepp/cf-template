import { Context, Effect, Schema } from "effect";

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
export interface ZoneEntrypoint {
  readonly zone: ZoneRef;
  readonly rules: ReadonlyArray<EntrypointRule>;
}

/**
 * The refusal of a zone whose `http_ratelimit` entrypoint holds rules this stack did not create.
 *
 * Cloudflare keeps one such entrypoint per zone, and the stack's `Cloudflare.Ruleset` writes the
 * whole of it, so deploying over foreign rules would overwrite them.
 */
export class ForeignRateLimitRules extends Schema.TaggedError<ForeignRateLimitRules>()(
  "ForeignRateLimitRules",
  {
    ruleIds: Schema.Array(Schema.String),
    zone: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to deploy: the rate-limit entrypoint of zone ${this.zone} holds ${this.ruleIds.length} rule(s) this stack did not create (${this.ruleIds.join(", ")}). A zone has one rate-limit entrypoint with one owner, and deploying would overwrite those rules. Move the rules into this stack, delete them in the Cloudflare dashboard, or point CUSTOM_DOMAIN at a zone that has none.`;
  }
}

/**
 * The failure of a Cloudflare call the guard made, with the operation that failed.
 */
export class RateLimitEntrypointError extends Schema.TaggedError<RateLimitEntrypointError>()(
  "RateLimitEntrypointError",
  { message: Schema.String },
) {}

/**
 * The one read the guard makes. Tests provide a fake; `RateLimitEntrypointLive` provides the real
 * one.
 */
export class RateLimitEntrypoint extends Context.Service<
  RateLimitEntrypoint,
  {
    /**
     * The zone of `hostname` and the rules of its `http_ratelimit` entrypoint.
     */
    readonly read: (hostname: string) => Effect.Effect<ZoneEntrypoint, RateLimitEntrypointError>;
  }
>()("infra/RateLimitEntrypoint") {}

/**
 * The `ref` this stack gives its rate-limit rule on one stage; the guard recognises its own rule
 * by it.
 *
 * @param stack - The stack name.
 * @param stage - The stage name.
 * @returns The rule's `ref`.
 */
export const rateLimitRef = (stack: string, stage: string): string =>
  `${stack}-${stage}-web-ratelimit`;

/**
 * The ids of the rules that do not carry `ref`.
 *
 * @param rules - The rules of the entrypoint.
 * @param ref - The `ref` of this stack's own rule.
 * @returns The ids of the foreign rules, in entrypoint order.
 */
export const foreignRuleIds = (
  rules: ReadonlyArray<EntrypointRule>,
  ref: string,
): ReadonlyArray<string> => rules.flatMap((rule) => (rule.ref === ref ? [] : [rule.id]));

/**
 * Refuse the zone of `hostname` when its `http_ratelimit` entrypoint holds any rule this stack did
 * not create, before the stack declares a `Cloudflare.Ruleset` on it. An absent or empty
 * entrypoint passes.
 *
 * @param hostname - The attached hostname, which selects the zone.
 * @param ref - The `ref` of this stack's own rule, from {@link rateLimitRef}.
 * @returns Success, {@link ForeignRateLimitRules}, or {@link RateLimitEntrypointError}.
 */
export const guardRateLimitOwner = Effect.fn("guardRateLimitOwner")(function* guardRateLimitOwner(
  hostname: string,
  ref: string,
) {
  const { rules, zone } = yield* (yield* RateLimitEntrypoint).read(hostname);
  const ruleIds = foreignRuleIds(rules, ref);

  yield* ruleIds.length > 0
    ? new ForeignRateLimitRules({ ruleIds, zone: `${zone.name} (${zone.id})` })
    : Effect.void;
});
