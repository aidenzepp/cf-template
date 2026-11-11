import { assert, describe, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Option } from "effect";
import {
  MIGRATIONS_DIR as APP_MIGRATIONS_DIR,
  d1Props as appProps,
} from "../../apps/api/src/db/database.ts";
import { migrationsDigest } from "../migrations-digest.ts";
import { APP_MIGRATIONS_DIGEST } from "../../apps/api/src/db/migrations-digest.ts";
import { MIGRATIONS_DIR, d1Props as authProps } from "../../apps/auth/src/db/database.ts";
import { AUTH_MIGRATIONS_DIGEST } from "../../apps/auth/src/db/migrations-digest.ts";

// Both databases apply their migrations and carry the migrations digest in a non-prod name.
const databases = [
  {
    extra: { migrations: APP_MIGRATIONS_DIR },
    name: "app",
    nonProdName: (stage: string) => `stack-app-${stage}-${APP_MIGRATIONS_DIGEST}`,
    props: appProps,
  },
  {
    extra: { migrations: MIGRATIONS_DIR },
    name: "auth",
    nonProdName: (stage: string) => `stack-auth-db-${stage}-${AUTH_MIGRATIONS_DIGEST}`,
    props: authProps,
  },
];

describe("migrations directories", () => {
  it.effect(
    "points the app database at apps/api/migrations, whose digest is the committed one",
    () =>
      Effect.gen(function* appDirectory() {
        assert.isTrue(APP_MIGRATIONS_DIR.endsWith("/apps/api/migrations"));
        assert.strictEqual(yield* migrationsDigest(APP_MIGRATIONS_DIR), APP_MIGRATIONS_DIGEST);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "points the auth database at apps/auth/migrations, whose digest is the committed one",
    () =>
      Effect.gen(function* authDirectory() {
        assert.isTrue(MIGRATIONS_DIR.endsWith("/apps/auth/migrations"));
        assert.strictEqual(yield* migrationsDigest(MIGRATIONS_DIR), AUTH_MIGRATIONS_DIGEST);
      }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("d1Props", () => {
  it.each(databases)(
    "leaves the $name prod database unnamed, without jurisdiction or hint",
    ({ extra, props }) => {
      const prod = props("stack", "prod", Option.none());

      assert.deepStrictEqual(prod, { ...extra });
    },
  );

  it.each(databases)(
    "sets the $name prod location hint only for a Some hint",
    ({ extra, props }) => {
      const prod = props("stack", "prod", Option.some("weur"));

      assert.deepStrictEqual(prod, { ...extra, primaryLocationHint: "weur" });
    },
  );

  it.each(databases)(
    "names the $name non-prod database explicitly and ignores the hint",
    ({ extra, nonProdName, props }) => {
      const test = props("stack", "test-i05", Option.some("weur"));

      assert.deepStrictEqual(test, { ...extra, name: nonProdName("test-i05") });
    },
  );
});
