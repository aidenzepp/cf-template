import type { ScryptCost } from "./auth-password.ts";

/**
 * The CPU one password hash costs, in ms: linear in the work `N x r x p`, anchored on the 115 ms
 * recorded for the default `N=2^15, r=8, p=3` (the work 786,432). Other tiers are an estimate until
 * a test stage measures them.
 *
 * @param cost - The scrypt cost parameters.
 * @returns The estimated CPU per hash, in ms.
 */
export const scryptCostMs = (cost: ScryptCost): number =>
  (115 * (2 ** cost.ln * cost.r * cost.p)) / (2 ** 15 * 8 * 3);

/**
 * The `auth` Worker's CPU limit: `headroom` hashes' worth of CPU, rounded up. With an integer
 * headroom of at least 1 it is never below one hash's cost, so one sign-in always fits.
 *
 * @param headroom - The value of `CPU_LIMIT_HEADROOM`.
 * @param cost - The scrypt cost parameters of new hashes.
 * @returns The CPU limit, in ms.
 */
export const authCpuLimitMs = (headroom: number, cost: ScryptCost): number =>
  Math.ceil(headroom * scryptCostMs(cost));

/**
 * The `limits` of one Worker: its CPU limit and the shared subrequest limit.
 *
 * @param worker - The Worker to compute for.
 * @param values - The limit knob values and the scrypt cost `auth` derives from.
 * @param values.headroom - The value of `CPU_LIMIT_HEADROOM`.
 * @param values.scrypt - The decoded `AUTH_PASSWORD_SCRYPT`.
 * @param values.webCpuMs - The value of `WEB_CPU_LIMIT_MS`.
 * @param values.apiCpuMs - The value of `API_CPU_LIMIT_MS`.
 * @param values.subrequests - The value of `WORKER_SUBREQUEST_LIMIT`.
 * @returns The `limits` prop of the Worker.
 */
export const limitsFor = (
  worker: "web" | "api" | "auth",
  values: {
    readonly headroom: number;
    readonly scrypt: ScryptCost;
    readonly webCpuMs: number;
    readonly apiCpuMs: number;
    readonly subrequests: number;
  },
) => {
  const cpuMs = {
    api: values.apiCpuMs,
    auth: authCpuLimitMs(values.headroom, values.scrypt),
    web: values.webCpuMs,
  }[worker];

  return { cpuMs, subrequests: values.subrequests };
};
