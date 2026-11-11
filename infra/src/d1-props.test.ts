import { assert, describe, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Option, Path } from "effect";
import {
  MIGRATIONS_URL as APP_MIGRATIONS_URL,
  d1Props as appProps,
  migrationsDir as appMigrationsDir,
} from "../../apps/api/src/db/database.ts";
import { migrationsDigest } from "../migrations-digest.ts";
import { APP_MIGRATIONS_DIGEST } from "../../apps/api/src/db/migrations-digest.ts";
import {
  MIGRATIONS_URL,
  d1Props as authProps,
  migrationsDir,
} from "../../apps/auth/src/db/database.ts";
import { AUTH_MIGRATIONS_DIGEST } from "../../apps/auth/src/db/migrations-digest.ts";

const MIGRATIONS = "/checkout/migrations";

// Both databases apply their migrations and carry the migrations digest in a non-prod name.
const databases = [
  {
    extra: { migrations: MIGRATIONS },
    name: "app",
    nonProdName: (stage: string) => `stack-app-${stage}-${APP_MIGRATIONS_DIGEST}`,
    props: (stack: string, stage: string, hint: Parameters<typeof appProps>[2]) =>
      appProps(stack, stage, hint, MIGRATIONS),
  },
  {
    extra: { migrations: MIGRATIONS },
    name: "auth",
    nonProdName: (stage: string) => `stack-auth-db-${stage}-${AUTH_MIGRATIONS_DIGEST}`,
    props: (stack: string, stage: string, hint: Parameters<typeof authProps>[2]) =>
      authProps(stack, stage, hint, MIGRATIONS),
  },
];

describe("migrations directories", () => {
  it.effect(
    "points the app database at apps/api/migrations, whose digest is the committed one",
    () =>
      Effect.gen(function* appDirectory() {
        const directory = yield* appMigrationsDir;

        assert.isTrue(directory.endsWith("/apps/api/migrations"));
        assert.strictEqual(yield* migrationsDigest(directory), APP_MIGRATIONS_DIGEST);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "points the auth database at apps/auth/migrations, whose digest is the committed one",
    () =>
      Effect.gen(function* authDirectory() {
        const directory = yield* migrationsDir;

        assert.isTrue(directory.endsWith("/apps/auth/migrations"));
        assert.strictEqual(yield* migrationsDigest(directory), AUTH_MIGRATIONS_DIGEST);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("decodes a percent-encoded file URL, so a checkout path with a space is real", () =>
    Effect.gen(function* decodes() {
      const path = yield* Path.Path;
      const url = new URL("file:///tmp/a%20b/migrations");

      assert.strictEqual(url.pathname, "/tmp/a%20b/migrations");
      assert.strictEqual(yield* path.fromFileUrl(url), "/tmp/a b/migrations");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("resolves both Worker directories from their URLs without percent-encoding", () =>
    Effect.gen(function* resolves() {
      const path = yield* Path.Path;

      assert.strictEqual(yield* appMigrationsDir, yield* path.fromFileUrl(APP_MIGRATIONS_URL));
      assert.strictEqual(yield* migrationsDir, yield* path.fromFileUrl(MIGRATIONS_URL));
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
