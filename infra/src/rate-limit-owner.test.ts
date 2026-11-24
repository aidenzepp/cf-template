import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  ForeignRateLimitRules,
  RateLimitEntrypoint,
  customDomainVariable,
  guardRateLimitOwner,
  rateLimitRef,
} from "./rate-limit-owner.ts";
import type { EntrypointRule } from "./rate-limit-owner.ts";
import { entrypointRules } from "./rate-limit-owner-live.ts";
import { RulesetNotFound } from "@distilled.cloud/cloudflare/rulesets";

const ref = rateLimitRef("app", "prod", "app.example.test");

const zone = { id: "zone-1", name: "example.test" };

/**
 * Run the guard against a fake entrypoint holding `rules`.
 */
const guard = (rules: ReadonlyArray<EntrypointRule>) =>
  guardRateLimitOwner("app.example.test", ref, "CUSTOM_DOMAIN").pipe(
    Effect.provideService(RateLimitEntrypoint, {
      read: () => Effect.succeed({ rules, zone }),
    }),
  );

describe("guardRateLimitOwner", () => {
  it.effect("passes an empty entrypoint", () => guard([]));

  it.effect("passes the stack's own rule", () => guard([{ id: "own-1", ref }]));

  it.effect("refuses one foreign rule, naming the zone, the id, the own ref and the variable", () =>
    Effect.gen(function* foreign() {
      const failure = yield* Effect.flip(guard([{ id: "dash-1", ref: undefined }]));

      assert.instanceOf(failure, ForeignRateLimitRules);
      assert.deepStrictEqual(
        failure,
        new ForeignRateLimitRules({
          ownRef: ref,
          ruleIds: ["dash-1"],
          variable: "CUSTOM_DOMAIN",
          zone: "example.test (zone-1)",
        }),
      );
      assert.include(failure.message, "example.test (zone-1)");
      assert.include(failure.message, "dash-1");
      assert.include(failure.message, ref);
      assert.include(failure.message, "CUSTOM_DOMAIN");
    }),
  );

  it.effect("names only the foreign rules of a mixed entrypoint", () =>
    Effect.gen(function* mixed() {
      const failure = yield* Effect.flip(
        guard([
          { id: "other-1", ref: "another-stack-ratelimit" },
          { id: "own-1", ref },
          { id: "dash-2", ref: undefined },
        ]),
      );

      assert.instanceOf(failure, ForeignRateLimitRules);
      assert.deepStrictEqual(failure.ruleIds, ["other-1", "dash-2"]);
      assert.notInclude(failure.message, "own-1");
    }),
  );
});

describe("rateLimitRef", () => {
  it("differs by hostname, so two projects of one repository name on a zone do not share a ref", () => {
    assert.notStrictEqual(
      rateLimitRef("app", "prod", "a.example.test"),
      rateLimitRef("app", "prod", "b.example.test"),
    );
  });

  it("keeps to a-z, 0-9, hyphen and underscore", () => {
    assert.match(rateLimitRef("app", "test-x", "app.example.test"), /^[a-z0-9_-]+$/u);
  });
});

describe("customDomainVariable", () => {
  it("names the variable the stage reads", () => {
    assert.strictEqual(customDomainVariable("prod"), "CUSTOM_DOMAIN");
    assert.strictEqual(customDomainVariable("test-x"), "STAGES_TEST_CUSTOM_DOMAIN");
  });
});

/**
 * An entrypoint read that fails with `RulesetNotFound` and `code`.
 */
const notFound = (code: number) => Effect.fail(new RulesetNotFound({ code, message: "m" }));

describe("entrypointRules", () => {
  it.effect("reads an absent entrypoint (code 10003) as no rules", () =>
    Effect.gen(function* absent() {
      assert.deepStrictEqual(yield* entrypointRules(notFound(10_003)), []);
    }),
  );

  it.effect("fails on code 10001 instead of reading it as absent", () =>
    Effect.gen(function* internal() {
      const failure = yield* Effect.flip(entrypointRules(notFound(10_001)));

      assert.instanceOf(failure, RulesetNotFound);
      assert.strictEqual(failure.code, 10_001);
    }),
  );

  it.effect("maps the rules of a present entrypoint", () =>
    Effect.gen(function* present() {
      const rules = yield* entrypointRules(
        Effect.succeed({
          rules: [
            { id: "r1", ref: "x" },
            { id: null, ref: null },
          ],
        }),
      );

      assert.deepStrictEqual(rules, [
        { id: "r1", ref: "x" },
        { id: "unknown", ref: undefined },
      ]);
    }),
  );
});
