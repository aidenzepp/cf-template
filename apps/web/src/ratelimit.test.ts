import { assert, describe, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { constVoid } from "effect/Function";
import { RateLimited } from "@workspace/contract/domain/rate-limited";
import { checkRateLimit, classify, fnv1a32, namespaceId } from "./ratelimit.ts";
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
 * Run a check while recording what reaches `console.error`.
 *
 * @param check - The effect to run.
 * @returns The check's result and the recorded console lines.
 */
const withConsole = <A>(check: Effect.Effect<A>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => vi.spyOn(console, "error").mockImplementation(constVoid)),
    (spy) => check.pipe(Effect.map((result) => ({ lines: spy.mock.calls.map(String), result }))),
    (spy) =>
      Effect.sync(() => {
        spy.mockRestore();
      }),
  );

/**
 * Require a check to have refused.
 *
 * @param check - The effect to run.
 * @returns The 429 response; a defect when the check allowed the request.
 */
const refusal = (check: Effect.Effect<Response | null>) =>
  check.pipe(
    Effect.flatMap((response) =>
      response === null ? Effect.die("expected a 429") : Effect.succeed(response),
    ),
  );

describe("fnv1a32", () => {
  it("matches the recorded vectors", () => {
    assert.strictEqual(fnv1a32(""), 0x81_1c_9d_c5);
    assert.strictEqual(fnv1a32("a"), 0xe4_0c_29_2c);
    assert.strictEqual(fnv1a32("stack:test-i24:public"), 0x8d_59_ab_c2);
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
  it("matches a credential path exactly and everything else is public", () => {
    assert.strictEqual(classify("/auth/sign-in/email", CREDENTIAL_PATHS), "credential");
    assert.strictEqual(classify("/auth/sign-in/email/", CREDENTIAL_PATHS), "public");
    assert.strictEqual(classify("/", CREDENTIAL_PATHS), "public");
  });
});

describe("checkRateLimit", () => {
  it.effect("passes a request both classes allow", () =>
    Effect.gen(function* allowedRequest() {
      const env = { RATELIMIT_CREDENTIAL: verdict(true), RATELIMIT_PUBLIC: verdict(true) };

      const { lines, result } = yield* withConsole(
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
      const problem = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RateLimited))(text);

      assert.strictEqual(problem.retryAfterSeconds, 10);
      assert.strictEqual(problem.status, 429);
      assert.strictEqual(problem.type, "/problems/rate-limited");
    }),
  );

  it.effect("fails open and logs one line naming the class whose call rejected", () =>
    Effect.gen(function* failOpen() {
      const env = { RATELIMIT_CREDENTIAL: rejecting, RATELIMIT_PUBLIC: verdict(true) };

      const { lines, result } = yield* withConsole(
        checkRateLimit(requestTo("/auth/sign-in/email", FROM_ONE_IP), env, CREDENTIAL_PATHS),
      );

      assert.isNull(result);
      assert.deepStrictEqual(lines, [
        '{"event":"web.ratelimit.error","ratelimit.class":"credential"}',
      ]);
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

      const { lines, result } = yield* withConsole(
        checkRateLimit(requestTo("/auth/sign-in/email"), env, CREDENTIAL_PATHS),
      );

      assert.isNull(result);
      assert.deepStrictEqual(lines, []);
      assert.strictEqual(credential.calls.count + publicClass.calls.count, 0);
    }),
  );
});
