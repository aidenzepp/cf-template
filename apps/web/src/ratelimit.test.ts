import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger, Predicate, References, Schema } from "effect";
import { RateLimited } from "@workspace/contract/domain/rate-limited";
import { checkRateLimit, classify, fnv1a32, namespaceId, rateLimitKey } from "./ratelimit.ts";
import type { RateLimitBinding } from "./ratelimit.ts";

const CREDENTIAL_PATHS = ["/auth/sign-in/email"];

const verdict = (success: boolean) => ({ limit: () => Promise.resolve({ success }) });

const rejecting: RateLimitBinding = { limit: () => Promise.reject(new Error("limiter down")) };

/**
 * A stub binding that counts its calls.
 *
 * @param binding - The stub to wrap.
 * @returns The wrapped stub and its call counter.
 */
const counted = (binding: RateLimitBinding) => {
  const calls = { count: 0 };

  return {
    binding: {
      limit: (options: { readonly key: string }) => {
        calls.count += 1;

        return binding.limit(options);
      },
    },
    calls,
  };
};

const requestTo = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://web.test${path}`, { headers });

const FROM_ONE_IP = { "cf-connecting-ip": "203.0.113.7" };

/**
 * Run a check while recording what reaches the Effect logger.
 *
 * @param check - The effect to run.
 * @returns The check's result and the recorded log lines.
 */
const withLogs = <A>(check: Effect.Effect<A>) =>
  Effect.gen(function* record() {
    const lines: Array<string> = [];

    const logger = Logger.make(({ fiber, message }) => {
      lines.push(
        `${String(message)} ${JSON.stringify(fiber.getRef(References.CurrentLogAnnotations))}`,
      );
    });

    const result = yield* check.pipe(Effect.provide(Logger.layer([logger])));

    return { lines, result };
  });

/**
 * Require a check to have refused.
 *
 * @param check - The effect to run.
 * @returns The 429 response; a defect when the check allowed the request.
 */
const refusal = (check: Effect.Effect<Response | null>) =>
  check.pipe(Effect.filterOrElse(Predicate.isNotNull, () => Effect.die("expected a 429")));

describe("fnv1a32", () => {
  it("matches the recorded vectors", () => {
    assert.strictEqual(fnv1a32(""), 0x81_1c_9d_c5);
    assert.strictEqual(fnv1a32("a"), 0xe4_0c_29_2c);
    assert.strictEqual(fnv1a32("stack:test-i24:public"), 0x8d_59_ab_c2);
  });
});

describe("rateLimitKey", () => {
  it("keeps an IPv4 address and an unparseable value as they are", () => {
    assert.strictEqual(rateLimitKey("203.0.113.7"), "203.0.113.7");
    assert.strictEqual(rateLimitKey("not:an:ip"), "not:an:ip");
    assert.strictEqual(rateLimitKey("1:2:3:4:5:6:7:8:9"), "1:2:3:4:5:6:7:8:9");
  });

  it("keys an IPv4-mapped IPv6 address as its IPv4", () => {
    assert.strictEqual(rateLimitKey("::ffff:192.0.2.1"), "192.0.2.1");
    assert.strictEqual(rateLimitKey("::FFFF:c000:201"), "192.0.2.1");
  });

  it("shares a key inside a /64, however the address is spelled", () => {
    assert.strictEqual(
      rateLimitKey("2001:db8::1"),
      rateLimitKey("2001:0db8:0000:0000:0000:0000:0000:0002"),
    );
    assert.strictEqual(
      rateLimitKey("2001:db8:1:2:aaaa::1"),
      rateLimitKey("2001:DB8:1:2:bbbb:cccc:dddd:eeee"),
    );
  });

  it("separates different /64 prefixes", () => {
    assert.notStrictEqual(rateLimitKey("2001:db8:0:1::1"), rateLimitKey("2001:db8:0:2::1"));
    assert.strictEqual(rateLimitKey("2001:db8::1"), "2001:db8:0:0::/64");
  });
});

describe("namespaceId", () => {
  it("stays within 1 to 2147483646 and differs by class", () => {
    const id = namespaceId("stack", "test-i24", "public");

    assert.strictEqual(id, 223_980_485);
    assert.isTrue(id >= 1 && id <= 2_147_483_646);
    assert.notStrictEqual(id, namespaceId("stack", "test-i24", "credential"));
  });
});

describe("classify", () => {
  it("classifies a credential path and every spelling of it as credential", () => {
    for (const path of [
      "/auth/sign-in/email",
      "/auth/sign-in/email/",
      "//auth//sign-in/email",
      "/AUTH/Sign-In/Email",
      "/auth/sign-in/%65mail",
      "/auth/%E0%A4%A",
    ]) {
      assert.strictEqual(classify(path, CREDENTIAL_PATHS), "credential", path);
    }
  });

  it("keeps the root and other paths public", () => {
    assert.strictEqual(classify("/", CREDENTIAL_PATHS), "public");
    assert.strictEqual(classify("/other", CREDENTIAL_PATHS), "public");
  });
});

describe("checkRateLimit", () => {
  it.effect("passes a request both classes allow", () =>
    Effect.gen(function* allowedRequest() {
      const env = { RATELIMIT_CREDENTIAL: verdict(true), RATELIMIT_PUBLIC: verdict(true) };

      const { lines, result } = yield* withLogs(
        checkRateLimit(requestTo("/auth/sign-in/email", FROM_ONE_IP), env, CREDENTIAL_PATHS),
      );

      assert.isNull(result);
      assert.deepStrictEqual(lines, []);
    }),
  );

  it.effect("answers 429 with the public period when only public refuses", () =>
    Effect.gen(function* publicRefused() {
      const env = { RATELIMIT_CREDENTIAL: verdict(true), RATELIMIT_PUBLIC: verdict(false) };

      const response = yield* refusal(
        checkRateLimit(requestTo("/", FROM_ONE_IP), env, CREDENTIAL_PATHS),
      );

      assert.strictEqual(response.status, 429);
      assert.strictEqual(response.headers.get("retry-after"), "10");
      assert.strictEqual(response.headers.get("content-type"), "application/problem+json");
    }),
  );

  it.effect("answers 429 with 60 when the credential class or both refuse", () =>
    Effect.gen(function* credentialRefused() {
      const path = requestTo("/auth/sign-in/email", FROM_ONE_IP);
      const only = { RATELIMIT_CREDENTIAL: verdict(false), RATELIMIT_PUBLIC: verdict(true) };
      const both = { RATELIMIT_CREDENTIAL: verdict(false), RATELIMIT_PUBLIC: verdict(false) };

      assert.strictEqual(
        (yield* checkRateLimit(path, only, CREDENTIAL_PATHS))?.headers.get("retry-after"),
        "60",
      );
      assert.strictEqual(
        (yield* checkRateLimit(path, both, CREDENTIAL_PATHS))?.headers.get("retry-after"),
        "60",
      );
    }),
  );

  it.effect("decodes the 429 body with RateLimited", () =>
    Effect.gen(function* body() {
      const env = { RATELIMIT_CREDENTIAL: verdict(true), RATELIMIT_PUBLIC: verdict(false) };

      const response = yield* refusal(
        checkRateLimit(requestTo("/", FROM_ONE_IP), env, CREDENTIAL_PATHS),
      );

      const text = yield* Effect.promise(() => response.text());
      const problem = yield* Schema.decodeEffect(Schema.fromJsonString(RateLimited))(text);

      assert.strictEqual(problem.retryAfterSeconds, 10);
      assert.strictEqual(problem.status, 429);
      assert.strictEqual(problem.type, "/problems/rate-limited");
    }),
  );

  it.effect("fails open and logs one line naming the class whose call rejected", () =>
    Effect.gen(function* failOpen() {
      const env = { RATELIMIT_CREDENTIAL: rejecting, RATELIMIT_PUBLIC: verdict(true) };

      const { lines, result } = yield* withLogs(
        checkRateLimit(requestTo("/auth/sign-in/email", FROM_ONE_IP), env, CREDENTIAL_PATHS),
      );

      assert.isNull(result);
      assert.deepStrictEqual(lines, ['web.ratelimit.error {"ratelimit.class":"credential"}']);
    }),
  );

  it.effect("calls neither binding and logs nothing without cf-connecting-ip", () =>
    Effect.gen(function* noIp() {
      const credential = counted(verdict(false));
      const publicClass = counted(verdict(false));

      const env = {
        RATELIMIT_CREDENTIAL: credential.binding,
        RATELIMIT_PUBLIC: publicClass.binding,
      };

      const { lines, result } = yield* withLogs(
        checkRateLimit(requestTo("/auth/sign-in/email"), env, CREDENTIAL_PATHS),
      );

      assert.isNull(result);
      assert.deepStrictEqual(lines, []);
      assert.strictEqual(credential.calls.count + publicClass.calls.count, 0);
    }),
  );
});
