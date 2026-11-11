import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { d1Props as appProps } from "../../apps/api/src/db/database.ts";
import { MIGRATIONS_DIR, d1Props as authProps } from "../../apps/auth/src/db/database.ts";
import { AUTH_MIGRATIONS_DIGEST } from "../../apps/auth/src/db/migrations-digest.ts";

// The auth database applies its migrations and carries the migrations digest in a non-prod name.
const databases = [
  { extra: {}, name: "app", nonProdName: (stage: string) => `stack-app-${stage}`, props: appProps },
  {
    extra: { migrations: MIGRATIONS_DIR },
    name: "auth",
    nonProdName: (stage: string) => `stack-auth-db-${stage}-${AUTH_MIGRATIONS_DIGEST}`,
    props: authProps,
  },
];

describe("d1Props", () => {
  for (const { extra, name, nonProdName, props } of databases) {
    it(`leaves the ${name} prod database unnamed, without jurisdiction or hint`, () => {
      const prod = props("stack", "prod", Option.none());

      assert.deepStrictEqual(prod, { ...extra });
    });

    it(`sets the ${name} prod location hint only for a Some hint`, () => {
      const prod = props("stack", "prod", Option.some("weur"));

      assert.deepStrictEqual(prod, { ...extra, primaryLocationHint: "weur" });
    });

    it(`names the ${name} non-prod database explicitly and ignores the hint`, () => {
      const test = props("stack", "test-i05", Option.some("weur"));

      assert.deepStrictEqual(test, { ...extra, name: nonProdName("test-i05") });
    });
  }
});
