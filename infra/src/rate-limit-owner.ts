import { Context, Effect, Schema } from "effect";
import { kindOf } from "../stages.ts";
import type { StageName } from "../stages.ts";

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
export class ForeignRateLimitRules extends Schema.TaggedError<
  ForeignRateLimitRules,
  { readonly brand: unique symbol }
>()("ForeignRateLimitRules", {
  ownRef: Schema.String,
  ruleIds: Schema.Array(Schema.String),
  variable: Schema.String,
  zone: Schema.String,
}) {
  override get message(): string {
    return `Refusing to deploy: the rate-limit entrypoint of zone ${this.zone} holds ${this.ruleIds.length} rule(s) whose ref is not ${this.ownRef} (${this.ruleIds.join(", ")}). A zone has one rate-limit entrypoint with one owner, and deploying would overwrite those rules. Remove or move them in the Cloudflare dashboard, or set ${this.variable} to a hostname on a zone with no rate-limit rules. If this stack was renamed, its earlier rule carries the old ref and counts as foreign.`;
  }
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

/**
 * The `ref` this stack gives its rate-limit rule on one stage and hostname; the guard recognises
 * its own rule by it.
 *
 * Two projects that share a repository name derive the same stack name, so the hostname, which is
 * unique within a zone and which the rule's expression already names, keeps their refs apart. The
 * ref uses only `a-z`, `0-9`, `-` and `_` (the dots of the hostname become `_`, which no hostname
 * contains, so the mapping is one to one). Cloudflare documents a `ref` as a string of at least one
 * character with no maximum length or pattern, so this is a conservative choice, not a limit it
 * states.
 *
 * @param stack - The stack name.
 * @param stage - The stage name.
 * @param hostname - The attached hostname.
 * @returns The rule's `ref`.
 */
export const rateLimitRef = (stack: string, stage: string, hostname: string): string =>
  `${stack}-${stage}-web-ratelimit-${hostname.replaceAll(".", "_")}`;

/**
 * The variable a stage reads its custom domain from: `CUSTOM_DOMAIN` on `prod`, and
 * `STAGES_TEST_CUSTOM_DOMAIN` on a `test` stage. No other stage kind honours a hostname.
 *
 * @param stage - The decoded stage.
 * @returns The variable's name.
 */
export const customDomainVariable = (stage: StageName): string =>
  kindOf(stage) === "prod" ? "CUSTOM_DOMAIN" : "STAGES_TEST_CUSTOM_DOMAIN";

/**
 * The ids of the rules that do not carry `ref`.
 *
 * @param rules - The rules of the entrypoint.
 * @param ref - The `ref` of this stack's own rule.
 * @returns The ids of the foreign rules, in entrypoint order.
 */
const foreignRuleIds = (rules: ReadonlyArray<EntrypointRule>, ref: string): ReadonlyArray<string> =>
  rules.flatMap((rule) => (rule.ref === ref ? [] : [rule.id]));

/**
 * Refuse the zone of `hostname` when its `http_ratelimit` entrypoint holds any rule this stack did
 * not create, before the stack declares a `Cloudflare.Ruleset` on it. An absent or empty
 * entrypoint passes.
 *
 * @param hostname - The attached hostname, which selects the zone.
 * @param ref - The `ref` of this stack's own rule, from {@link rateLimitRef}.
 * @param variable - The variable the hostname came from, from {@link customDomainVariable}.
 * @returns Success, {@link ForeignRateLimitRules}, or {@link RateLimitEntrypointError}.
 */
export const guardRateLimitOwner = Effect.fn("guardRateLimitOwner")(function* guardRateLimitOwner(
  hostname: string,
  ref: string,
  variable: string,
) {
  const { rules, zone } = yield* (yield* RateLimitEntrypoint).read(hostname, variable);
  const ruleIds = foreignRuleIds(rules, ref);

  yield* ruleIds.length > 0
    ? new ForeignRateLimitRules({
        ownRef: ref,
        ruleIds,
        variable,
        zone: `${zone.name} (${zone.id})`,
      })
    : Effect.void;
});
