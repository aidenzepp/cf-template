import type { ScryptCost } from "./auth/password.ts";

/**
 * The CPU one password hash costs, in ms: linear in the work `N x r x p`, anchored on the 115 ms
 * recorded for the default `N=2^15, r=8, p=3` (the work 786,432). Other tiers are an estimate until
 * a test stage measures them.
 *
 * @param cost - The scrypt cost parameters.
 * @returns The estimated CPU per hash, in ms.
 */
export const scryptCostMs = (cost: ScryptCost) =>
  (115 * (2 ** cost.ln * cost.r * cost.p)) / (2 ** 15 * 8 * 3);

/**
 * The `auth` Worker's CPU limit: `headroom` hashes' worth of CPU, rounded up. With an integer
 * headroom of at least 1 it is never below one hash's cost, so one sign-in always fits.
 *
 * @param headroom - The value of `CPU_LIMIT_HEADROOM`.
 * @param cost - The scrypt cost parameters of new hashes.
 * @returns The CPU limit, in ms.
 */
export const authCpuLimitMs = (headroom: number, cost: ScryptCost) =>
  Math.ceil(headroom * scryptCostMs(cost));
