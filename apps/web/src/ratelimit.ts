import { Effect, Number as Num, Result } from "effect";
import { HttpServerResponse, ProblemDetails } from "effect/http";

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

const HEX_GROUP = /^[\da-f]{1,4}$/u;

const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * The two hex groups of a dotted IPv4 address.
 *
 * @param text - The candidate, such as `192.0.2.1`.
 * @returns The two groups, or `undefined` when the text is not an IPv4 address.
 */
const quadGroups = (text: string): ReadonlyArray<string> | undefined => {
  const octets = text.split(".").map(Number);

  if (!DOTTED_QUAD.test(text) || octets.some((octet) => octet > 255)) {
    return undefined;
  }

  const [a = 0, b = 0, c = 0, d = 0] = octets;

  return [(a * 256 + b).toString(16), (c * 256 + d).toString(16)];
};

/**
 * The hex groups on one side of `::`.
 *
 * @param side - The colon-separated groups, possibly empty.
 * @param endsAddress - Whether the side ends the address, so a dotted IPv4 tail is allowed.
 * @returns The groups, or `undefined` when one is malformed.
 */
const sideGroups = (side: string, endsAddress: boolean): ReadonlyArray<string> | undefined => {
  if (side === "") {
    return [];
  }

  const parts = side.split(":");
  const last = parts.at(-1) ?? "";
  const tail = endsAddress && last.includes(".") ? quadGroups(last) : [last];
  const groups = tail === undefined ? undefined : [...parts.slice(0, -1), ...tail];

  return groups?.every((group) => HEX_GROUP.test(group)) === true ? groups : undefined;
};

/**
 * Expand an IPv6 address to its eight 16-bit groups.
 *
 * @param ip - A lower-case IPv6 address, `::` compressed or not, with an optional IPv4 tail.
 * @returns The eight groups, or `undefined` when the text is not an IPv6 address.
 */
const expandIpv6 = (ip: string): ReadonlyArray<number> | undefined => {
  const [head = "", tail, ...extra] = ip.split("::");

  if (extra.length > 0) {
    return undefined;
  }

  const front = sideGroups(head, tail === undefined);
  const back = tail === undefined ? [] : sideGroups(tail, true);

  if (front === undefined || back === undefined) {
    return undefined;
  }

  const filler = tail === undefined ? 0 : 8 - front.length - back.length;

  if (tail === undefined ? front.length !== 8 : filler < 1) {
    return undefined;
  }

  return [...front, ...Array.from({ length: filler }, () => "0"), ...back].map((group) =>
    Number.parseInt(group, 16),
  );
};

/**
 * The limiter key of a caller: an IPv4 address as is, an IPv4-mapped IPv6 address as its IPv4, and
 * any other IPv6 address as its /64, so one client cannot rotate addresses inside its own prefix.
 *
 * @param ip - The `cf-connecting-ip` value.
 * @returns The key; an address that does not parse is returned as is.
 */
export const rateLimitKey = (ip: string): string => {
  const lower = ip.toLowerCase();

  if (!lower.includes(":")) {
    return ip;
  }

  const groups = expandIpv6(lower);

  if (groups === undefined) {
    return ip;
  }

  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xff_ff) {
    const [high = 0, low = 0] = groups.slice(6);

    return `${Math.floor(high / 256)}.${high % 256}.${Math.floor(low / 256)}.${low % 256}`;
  }

  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
};

/**
 * Fold the spellings a router may treat as one route: repeated slashes, a trailing slash and case.
 *
 * @param path - A percent-decoded path.
 * @returns The path in lower case with single slashes and no trailing slash, except the root.
 */
const normalizePath = (path: string): string => {
  const collapsed = path.toLowerCase().replaceAll(/\/+/gu, "/");

  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
};

/**
 * Classify a path against the credential paths after percent-decoding and normalizing both. A path
 * that does not decode is `credential`: over-classifying is safe, under-classifying is a bypass.
 *
 * @param pathname - The request path.
 * @param credentialPaths - Every path that hashes or verifies a password.
 * @returns `credential` for a listed path or an undecodable one, else `public`.
 */
export const classify = (
  pathname: string,
  credentialPaths: ReadonlyArray<string>,
): RateLimitClass => {
  const decoded = Result.try(() => decodeURIComponent(pathname));

  return Result.isFailure(decoded) ||
    credentialPaths.some((path) => normalizePath(path) === normalizePath(decoded.success))
    ? "credential"
    : "public";
};

/**
 * Ask one binding whether the caller may proceed. A rejected `limit` fails open: it logs one
 * `web.ratelimit.error` error naming the class and answers allowed.
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
      Effect.logError("web.ratelimit.error").pipe(
        Effect.annotateLogs("ratelimit.class", cls),
        Effect.as(true),
      ),
    ),
  );

/**
 * The 429 answer: a problem body and `Retry-After`, with no HTML, log or span.
 *
 * @param retryAfterSeconds - The wait to report.
 * @returns The response.
 */
const tooManyRequests = (retryAfterSeconds: number) =>
  HttpServerResponse.toWeb(
    HttpServerResponse.setHeader(
      ProblemDetails.toResponse({
        retryAfterSeconds,
        status: 429,
        title: "Too many requests",
        type: "/problems/rate-limited",
      }),
      "retry-after",
      String(retryAfterSeconds),
    ),
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
  credentialPaths: ReadonlyArray<string>,
): Effect.Effect<Response | null> => {
  const ip = request.headers.get("cf-connecting-ip");

  if (ip === null) {
    return Effect.succeed(null);
  }

  const key = rateLimitKey(ip);

  const classes: ReadonlyArray<RateLimitClass> =
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
