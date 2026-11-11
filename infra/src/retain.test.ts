import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { RemovalPolicy } from "alchemy";
import { Effect, Option } from "effect";
import { declareWith as declareAppDb } from "../../apps/api/src/db/database.ts";
import { declareWith as declareAuthDb } from "../../apps/auth/src/db/database.ts";

// A stand-in D1 resource that reports the removal policy it was declared under, so the tests see
// what the declaration applies without a provider or an account.
const reportPolicy = () =>
  Effect.map(Effect.serviceOption(RemovalPolicy.RemovalPolicy), Option.getOrUndefined);

// The stateful types this block declares are the two D1 databases. The state store is declared
// through `Cloudflare.state` and has no removal prop; KV namespaces arrive with their block.
const databases = [
  { declare: declareAppDb, name: "app" },
  { declare: declareAuthDb, name: "auth" },
];

describe("D1 removal policy", () => {
  for (const { declare, name } of databases) {
    it.effect(`declares the ${name} database as retained on prod`, () =>
      Effect.gen(function* prod() {
        const policy = yield* declare(reportPolicy, "stack", "prod", Option.none());

        assert.strictEqual(policy, "retain");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect(`declares the ${name} database as destroyed on a test stage`, () =>
      Effect.gen(function* test() {
        const policy = yield* declare(reportPolicy, "stack", "test-i05", Option.none());

        assert.strictEqual(policy, "destroy");
      }).pipe(Effect.provide(BunServices.layer)),
    );
  }
});
