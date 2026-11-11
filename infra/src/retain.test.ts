import { assert, describe, it } from "@effect/vitest";
import { retainsD1 as retainsAppDb } from "../../apps/api/src/db/database.ts";
import { retainsD1 as retainsAuthDb } from "../../apps/auth/src/db/database.ts";

// The stateful types this block declares are the two D1 databases. The state store is declared
// through `Cloudflare.state` and has no removal prop; KV namespaces arrive with their block.
const databases = [
  { name: "app", retains: retainsAppDb },
  { name: "auth", retains: retainsAuthDb },
];

describe("D1 removal policy", () => {
  for (const { name, retains } of databases) {
    it(`retains the ${name} database on prod`, () => {
      assert.isTrue(retains("prod"));
    });

    it(`removes the ${name} database with its resource on a test stage`, () => {
      assert.isFalse(retains("test-i05"));
    });
  }
});
