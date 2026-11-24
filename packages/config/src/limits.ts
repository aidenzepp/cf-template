import { Config, Schema } from "effect";
import { Knob } from "./knob.ts";

/**
 * A positive whole number, the base of every limit knob's schema.
 */
const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * The multiplier over one hash's CPU cost that bounds the `auth` Worker's CPU limit, read as
 * `CPU_LIMIT_HEADROOM`. Named in SCREAMING_CASE like `AUTH_PASSWORD_SCRYPT`, the knob it derives
 * from.
 */
export const CPU_LIMIT_HEADROOM = Knob.make(
  "CPU_LIMIT_HEADROOM",
  positiveInt.annotate({
    default: 10,
    description: "Multiplier over one hash's CPU cost that bounds the auth Worker's CPU limit.",
  }),
);

/**
 * The CPU limit of the `web` Worker per invocation, in ms, read as `WEB_CPU_LIMIT_MS`.
 */
export const WEB_CPU_LIMIT_MS = Knob.make(
  "WEB_CPU_LIMIT_MS",
  positiveInt.annotate({
    default: 500,
    description:
      "CPU limit of the web Worker per invocation, in ms; placeholder until a test stage measures p99.",
  }),
);

/**
 * The CPU limit of the `api` Worker per invocation, in ms, read as `API_CPU_LIMIT_MS`.
 */
export const API_CPU_LIMIT_MS = Knob.make(
  "API_CPU_LIMIT_MS",
  positiveInt.annotate({
    default: 500,
    description:
      "CPU limit of the api Worker per invocation, in ms; placeholder until a test stage measures p99.",
  }),
);

/**
 * The subrequest limit per invocation shared by the three Workers, read as
 * `WORKER_SUBREQUEST_LIMIT`.
 */
export const WORKER_SUBREQUEST_LIMIT = Knob.make(
  "WORKER_SUBREQUEST_LIMIT",
  positiveInt.annotate({
    default: 100,
    description: "Subrequest limit per invocation, applied to web, api and auth alike.",
  }),
);

/**
 * The deploy-time value of every limit knob, read once through `Config`.
 */
export const limitKnobs = Config.all({
  apiCpuMs: API_CPU_LIMIT_MS.config,
  headroom: CPU_LIMIT_HEADROOM.config,
  subrequests: WORKER_SUBREQUEST_LIMIT.config,
  webCpuMs: WEB_CPU_LIMIT_MS.config,
});
