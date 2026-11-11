import { Effect, Number as Num } from "effect";

/**
 * The Workers `ratelimit` binding: one `limit` call per request, answering only whether it passed.
 */
export interface RateLimitBinding {
  readonly limit: (options: { readonly key: string }) => Promise<{ readonly success: boolean }>;
}

/**
 * The two limiter classes: `public` brakes every request, `credential` additionally brakes the
 * password routes.
 */
export type RateLimitClass = "public" | "credential";

/**
 * The seconds a refused caller is told to wait, the period of the binding's class. The binding
 * answers only `{ success }`, so the class period is the honest value.
 */
const PERIOD_SECONDS = { credential: 60, public: 10 } as const satisfies Record<
  RateLimitClass,
  number
>;

/**
 * The bindings `checkRateLimit` reads.
 */
interface RateLimitEnv {
  readonly RATELIMIT_CREDENTIAL: RateLimitBinding;
  readonly RATELIMIT_PUBLIC: RateLimitBinding;
}

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;

const FNV_PRIME = 0x01_00_01_93;

/**
 * XOR a byte into the low eight bits of a hash, by bit arithmetic: the repository lint forbids
 * bitwise operators.
 *
 * @param hash - The running hash, an unsigned 32-bit number.
 * @param byte - The byte to mix in, from `0` to `255`.
 * @returns The hash with its low byte XORed with `byte`.
 */
const xorLowByte = (hash: number, byte: number): number => {
  const low = hash % 256;

  const differing = Array.from({ length: 8 }, (_, bit) => 2 ** bit).filter(
    (weight) => Math.floor(low / weight) % 2 !== Math.floor(byte / weight) % 2,
  );

  return hash - low + Num.sumAll(differing);
};

/**
 * FNV-1a over the UTF-8 bytes of a text, in unsigned 32-bit arithmetic.
 *
 * @param text - The text to hash.
 * @returns The hash, from `0` to `4294967295`.
 */
export const fnv1a32 = (text: string): number => {
  let hash = FNV_OFFSET_BASIS;

  for (const byte of new TextEncoder().encode(text)) {
    hash = Uint32Array.of(Math.imul(xorLowByte(hash, byte), FNV_PRIME)).at(0) ?? hash;
  }

  return hash;
};

/**
 * The limiter namespace id of a project, stage and class. Counters are account-wide per id, so the
 * id derives from all three.
 *
 * @param stack - The stack name.
 * @param stage - The stage name.
 * @param cls - The limiter class.
 * @returns An id from `1` to `2147483646`.
 */
export const namespaceId = (stack: string, stage: string, cls: RateLimitClass): number =>
  1 + (fnv1a32(`${stack}:${stage}:${cls}`) % 2_147_483_646);

/**
 * Classify a path by exact match against the credential paths.
 *
 * @param pathname - The request path.
 * @param credentialPaths - Every path that hashes or verifies a password.
 * @returns `credential` for a listed path, else `public`.
 */
export const classify = (pathname: string, credentialPaths: readonly string[]): RateLimitClass =>
  credentialPaths.includes(pathname) ? "credential" : "public";

/**
 * Ask one binding whether the caller may proceed. A rejected `limit` fails open: it emits one
 * `web.ratelimit.error` line naming the class and answers allowed.
 *
 * @param binding - The binding of the class.
 * @param cls - The class the binding serves.
 * @param key - The caller's key.
 * @returns Whether the caller is within the limit.
 */
const allowed = (binding: RateLimitBinding, cls: RateLimitClass, key: string) =>
  Effect.tryPromise(() => binding.limit({ key })).pipe(
    Effect.map((outcome) => outcome.success),
    Effect.catch(() =>
      Effect.sync(() => {
        console.error(JSON.stringify({ event: "web.ratelimit.error", "ratelimit.class": cls }));

        return true;
      }),
    ),
  );

/**
 * The 429 answer: an `application/problem+json` body and `Retry-After`, with no HTML, log or span.
 *
 * @param retryAfterSeconds - The wait to report.
 * @returns The response.
 */
const tooManyRequests = (retryAfterSeconds: number) =>
  Response.json(
    {
      retryAfterSeconds,
      status: 429,
      title: "Too many requests",
      type: "/problems/rate-limited",
    },
    {
      headers: {
        "content-type": "application/problem+json",
        "retry-after": String(retryAfterSeconds),
      },
      status: 429,
    },
  );

/**
 * Check a request against the limiter, keyed by `cf-connecting-ip`. A request without the header
 * skips both bindings and emits nothing.
 *
 * @param request - The inbound request.
 * @param env - The two limiter bindings.
 * @param credentialPaths - Every path that hashes or verifies a password.
 * @returns The 429 response when a class refuses, else `null`. Never fails.
 */
export const checkRateLimit = (
  request: Request,
  env: RateLimitEnv,
  credentialPaths: readonly string[],
): Effect.Effect<Response | null> => {
  const key = request.headers.get("cf-connecting-ip");

  if (key === null) {
    return Effect.succeed(null);
  }

  const classes: readonly RateLimitClass[] =
    classify(new URL(request.url).pathname, credentialPaths) === "credential"
      ? ["public", "credential"]
      : ["public"];

  return Effect.all(
    classes.map((cls) =>
      allowed(cls === "public" ? env.RATELIMIT_PUBLIC : env.RATELIMIT_CREDENTIAL, cls, key).pipe(
        Effect.map((ok) => (ok ? 0 : PERIOD_SECONDS[cls])),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((waits) => {
      const wait = Math.max(...waits);

      return wait === 0 ? null : tooManyRequests(wait);
    }),
  );
};
