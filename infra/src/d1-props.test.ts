import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { d1Props as appProps } from "../../apps/api/src/db/database.ts";
import { d1Props as authProps } from "../../apps/auth/src/db/database.ts";

const databases = [
  { name: "app", props: appProps },
  { name: "auth", props: authProps },
];

describe("d1Props", () => {
  for (const { name, props } of databases) {
    it(`leaves the ${name} prod database unnamed, without jurisdiction or hint`, () => {
      const prod = props("stack", "prod", Option.none());

      assert.deepStrictEqual(prod, {});
    });

    it(`sets the ${name} prod location hint only for a Some hint`, () => {
      const prod = props("stack", "prod", Option.some("weur"));

      assert.deepStrictEqual(prod, { primaryLocationHint: "weur" });
    });

    it(`names the ${name} non-prod database explicitly and ignores the hint`, () => {
      const test = props("stack", "test-i05", Option.some("weur"));

      assert.deepStrictEqual(test, { name: `stack-${name}-test-i05` });
    });
  }
});
