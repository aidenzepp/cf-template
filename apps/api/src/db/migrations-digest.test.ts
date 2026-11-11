import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, Path } from "effect";
import { migrationsDigest } from "../../../../infra/migrations-digest.ts";
import { APP_MIGRATIONS_DIGEST } from "./migrations-digest.ts";

it.effect("holds the digest of the committed migration files", () =>
  Effect.gen(function* recomputes() {
    const path = yield* Path.Path;
    const directory = yield* path.fromFileUrl(new URL("../../migrations", import.meta.url));

    assert.strictEqual(yield* migrationsDigest(directory), APP_MIGRATIONS_DIGEST);
  }).pipe(Effect.provide(BunServices.layer)),
);
