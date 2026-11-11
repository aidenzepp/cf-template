import { Config, Schema } from "effect";
import { Knob } from "./knob.ts";

/**
 * The durations, in seconds, Cloudflare accepts for a rate-limit rule's counting period: 10 s,
 * 1, 2, 5 and 10 min, and 1 h. The pinned `Ruleset` types leave the field a plain `number`, so
 * the set is Cloudflare's documented one, and a zone's plan may allow only part of it.
 */
const periodSeconds = Schema.Literals([10, 60, 120, 300, 600, 3600]);

/**
 * The durations, in seconds, Cloudflare accepts for a rate-limit rule's block: the periods plus
 * 1 day.
 */
const mitigationSeconds = Schema.Literals([10, 60, 120, 300, 600, 3600, 86_400]);

/**
 * The requests one IP may make per period outside `/assets/` before the owned-domain WAF rule
 * blocks it, read as `WAF_RATE_LIMIT_REQUESTS`.
 */
export const WAF_RATE_LIMIT_REQUESTS = Knob.make(
  "WAF_RATE_LIMIT_REQUESTS",
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    default: 50,
    description:
      "Requests one IP may make per period outside /assets/ before the owned-domain WAF rule blocks it.",
  }),
);

/**
 * The counting period of the owned-domain WAF rule, in seconds, read as
 * `WAF_RATE_LIMIT_PERIOD_SECONDS`.
 */
export const WAF_RATE_LIMIT_PERIOD_SECONDS = Knob.make(
  "WAF_RATE_LIMIT_PERIOD_SECONDS",
  periodSeconds.annotate({
    default: 10,
    description: "Seconds over which the owned-domain WAF rule counts one IP's requests.",
  }),
);

/**
 * How long the owned-domain WAF rule blocks an IP once it trips, in seconds, read as
 * `WAF_RATE_LIMIT_MITIGATION_SECONDS`.
 */
export const WAF_RATE_LIMIT_MITIGATION_SECONDS = Knob.make(
  "WAF_RATE_LIMIT_MITIGATION_SECONDS",
  mitigationSeconds.annotate({
    default: 10,
    description: "Seconds the owned-domain WAF rule blocks an IP after it exceeds the limit.",
  }),
);

/**
 * The deploy-time value of every WAF rate-limit knob, read once through `Config`.
 */
export const wafKnobs = Config.all({
  mitigationSeconds: WAF_RATE_LIMIT_MITIGATION_SECONDS.config,
  periodSeconds: WAF_RATE_LIMIT_PERIOD_SECONDS.config,
  requests: WAF_RATE_LIMIT_REQUESTS.config,
});
