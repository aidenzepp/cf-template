import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import type { Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { GuardedRepository } from "./repository.ts";
import { UNSUPPORTED_OWNER, detectPlan, detectTier } from "./tier.ts";

const organization: GuardedRepository = {
  name: "widget",
  owner: "acme",
  ownerType: "Organization",
  visibility: "private",
};

/**
 * A fake `HttpClient` that answers `GET /orgs/acme` with one status and body and 404s the rest.
 *
 * @param status - The status of the organization read.
 * @param body - The JSON body of the organization read.
 * @returns The layer providing the client and a token.
 */
const organizationReply = (status: number, body: Schema.Json) =>
  Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            url.pathname === "/orgs/acme"
              ? Response.json(body, { status })
              : Response.json({}, { status: 404 }),
          ),
        ),
      ),
    ),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "ghp_secret" })),
  );

describe("organization owner", () => {
  it.effect("reports an unsupported owner when the organization response has no plan", () =>
    Effect.gen(function* noPlan() {
      const plan = yield* detectPlan(organization).pipe(
        Effect.provide(organizationReply(200, { login: "acme" })),
      );

      assert.strictEqual(plan, UNSUPPORTED_OWNER);
    }),
  );

  it.effect("treats a private organization without a readable plan as Free", () =>
    Effect.gen(function* free() {
      const tier = yield* detectTier(organization, []).pipe(
        Effect.provide(organizationReply(200, { login: "acme" })),
      );

      assert.strictEqual(tier.plan, UNSUPPORTED_OWNER);
      assert.strictEqual(tier.branchProtection, "none");
      assert.isFalse(tier.capabilities.has("rulesets"));
    }),
  );

  it.effect("fails with a typed TierError when the organization read is 404", () =>
    Effect.gen(function* missing() {
      const failure = yield* Effect.flip(
        detectPlan(organization).pipe(
          Effect.provide(organizationReply(404, { message: "Not Found" })),
        ),
      );

      assert.strictEqual(failure._tag, "TierError");
      assert.include(failure.message, "Cannot read the plan of the repository owner");
      assert.notInclude(failure.message, "ghp_secret");
    }),
  );
});
