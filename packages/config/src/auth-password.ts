import { Schema } from "effect";
import { Knob } from "@workspace/config/knob";

/**
 * The least memory, in bytes, one scrypt call may use: `128 x 2^ln x r` of 32 MiB.
 */
export const SCRYPT_MEMORY_FLOOR_BYTES = 33_554_432;

/**
 * The most memory, in bytes, one scrypt call may use: 64 MiB. Two hashes in flight must still fit
 * the 128 MB Workers isolate.
 */
export const SCRYPT_MEMORY_CEILING_BYTES = 67_108_864;

/**
 * The least work one scrypt call may do, `2^ln x r x p` of `2^18`. Every parameter set OWASP lists
 * clears it, and the default of `2^15 x 8 x 3` does too.
 */
export const SCRYPT_WORK_FLOOR = 262_144;

/**
 * The memory one scrypt call needs, `128 x 2^ln x r`, in bytes.
 *
 * @param params - The cost parameters.
 * @returns The bytes of working memory.
 */
const memoryOf = (params: { readonly ln: number; readonly r: number }): number =>
  128 * 2 ** params.ln * params.r;

/**
 * The scrypt cost parameters: `ln` is log2 of `N`, `r` the block size, `p` the parallelism.
 *
 * The bounds keep the arithmetic exact and the ceiling caps memory. The floors are not part of this
 * schema because a stored hash may predate a raised floor, so `verify` decodes {@link ScryptParams}
 * alone: it is bounded by the ceiling and never by the floors.
 */
export const ScryptParams = Schema.Struct({
  ln: Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 10 })),
  p: Schema.Int.check(Schema.isBetween({ maximum: 16, minimum: 1 })),
  r: Schema.Int.check(Schema.isBetween({ maximum: 32, minimum: 1 })),
}).check(
  Schema.makeFilter(
    (params) =>
      memoryOf(params) <= SCRYPT_MEMORY_CEILING_BYTES ||
      `scrypt memory 128 x 2^ln x r is ${memoryOf(params)} bytes, over the ${SCRYPT_MEMORY_CEILING_BYTES} byte (64 MiB) ceiling`,
  ),
);

/**
 * The scrypt cost parameters.
 */
export type ScryptCost = typeof ScryptParams.Type;

/**
 * The parameters a new hash must use: {@link ScryptParams} plus the two floors, memory and work
 * apart, so a large `p` cannot buy back memory.
 */
export const ScryptKnobParams = ScryptParams.check(
  Schema.makeFilter(
    (params) =>
      memoryOf(params) >= SCRYPT_MEMORY_FLOOR_BYTES ||
      `scrypt memory 128 x 2^ln x r is ${memoryOf(params)} bytes, under the ${SCRYPT_MEMORY_FLOOR_BYTES} byte (32 MiB) floor`,
  ),
  Schema.makeFilter(
    (params) =>
      2 ** params.ln * params.r * params.p >= SCRYPT_WORK_FLOOR ||
      `scrypt work 2^ln x r x p is ${2 ** params.ln * params.r * params.p}, under the floor of ${SCRYPT_WORK_FLOOR}`,
  ),
);

/**
 * The cost of every new password hash, as the JSON text `{"ln":15,"r":8,"p":3}`. The default is
 * `N=2^15, r=8, p=3`.
 */
export const AUTH_PASSWORD_SCRYPT = Knob.make(
  "AUTH_PASSWORD_SCRYPT",
  Schema.fromJsonString(ScryptKnobParams).annotate({
    default: { ln: 15, p: 3, r: 8 },
    description:
      'scrypt cost of new password hashes as JSON, {"ln":15,"r":8,"p":3}: memory 128 x 2^ln x r from 32 MiB to 64 MiB, work 2^ln x r x p at least 2^18.',
  }),
);

/**
 * The bytes of `maxmem` a scrypt call needs for `params`: `2 x 128 x 2^ln x r`, Better Auth's own
 * value, so Node never rejects parameters this module accepts.
 *
 * @param params - The cost parameters.
 * @returns The `maxmem` option.
 */
export const scryptMaxmem = (params: ScryptCost): number => 2 * memoryOf(params);
