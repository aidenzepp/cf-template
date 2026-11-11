import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Path, Schema } from "effect";
import { Compat, compat } from "./compat.ts";

/**
 * Read the build date of the installed `workerd` from the middle component of its version
 * `1.<YYYYMMDD>.<n>`.
 *
 * `workerd` arrives in `node_modules` through `@alchemy.run/cloudflare-runtime`, a dependency of
 * `@alchemy.run/cloudflare`, as a `workerd@<version>` entry of Bun's package store.
 */
const workerdDate = Effect.gen(function* readWorkerdDate() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* path.fromFileUrl(new URL("../../node_modules/.bun", import.meta.url));
  const entries = yield* fs.readDirectory(store);
  const entry = entries.find((name) => /^workerd@\d+\.\d{8}\.\d+$/u.test(name));

  assert.isDefined(entry);

  const stamp = (entry ?? "").split(".")[1] ?? "";

  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}).pipe(Effect.provide(BunServices.layer));

describe("compat module", () => {
  it.effect("matches its schema", () =>
    Effect.gen(function* decodes() {
      const decoded = yield* Schema.decodeUnknownEffect(Compat)(compat);

      assert.deepStrictEqual(decoded, compat);
    }),
  );

  it.live("keeps the date no later than today", () =>
    Effect.gen(function* notFuture() {
      const today = DateTime.formatIsoDateUtc(yield* DateTime.now);

      assert.isTrue(compat.date <= today);
    }),
  );

  it.effect("keeps the date at or after the installed workerd build date", () =>
    Effect.gen(function* notStale() {
      const date = yield* workerdDate;

      assert.isTrue(compat.date >= date);
    }),
  );

  it.effect("turns every flag on by default after the date", () =>
    Effect.sync(() => {
      for (const flag of compat.flags) {
        assert.isTrue(flag.defaultOn > compat.date);
      }
    }),
  );
});
