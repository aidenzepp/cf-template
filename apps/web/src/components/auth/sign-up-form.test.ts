import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { OrphanGraceSeconds, makeOrphanGraceLayer } from "../../web-layer.ts";
import { orphanGraceLine } from "./sign-up-form.tsx";

const readGrace = (text: string) =>
  OrphanGraceSeconds.pipe(
    Effect.provide(makeOrphanGraceLayer({ AUTH_ORPHAN_GRACE_SECONDS: text })),
  );

describe("sign-up orphan-grace lines", () => {
  it("renders whole minutes on the 5xx line and the already-exists line", () => {
    expect(orphanGraceLine({ status: 503 }, 600)).toBe(
      "We couldn't finish creating your account. Wait 10 minutes, then sign up again with the same email, or use another email.",
    );
    expect(orphanGraceLine({ code: "USER_ALREADY_EXISTS", status: 422 }, 600)).toBe(
      "If you just tried to sign up and it failed, wait 10 minutes and sign up again.",
    );
  });

  it("rounds a part minute up", () => {
    expect(orphanGraceLine({ status: 500 }, 90)).toContain("Wait 2 minutes");
    expect(orphanGraceLine({ code: "USER_ALREADY_EXISTS", status: 422 }, 90)).toContain(
      "wait 2 minutes",
    );
  });

  it("adds nothing to other failures", () => {
    expect(orphanGraceLine({ code: "PASSWORD_TOO_SHORT", status: 400 }, 600)).toBeNull();
    expect(orphanGraceLine({ status: 429 }, 600)).toBeNull();
  });

  it.effect("reads the bound text through the knob's Config", () =>
    Effect.gen(function* bound() {
      expect(yield* readGrace("90")).toBe(90);

      expect(yield* readGrace("600")).toBe(600);
    }),
  );

  it.effect("fails on a value outside 60 to 3600", () =>
    Effect.gen(function* invalid() {
      const error = yield* Effect.flip(
        Layer.build(makeOrphanGraceLayer({ AUTH_ORPHAN_GRACE_SECONDS: "59" })),
      ).pipe(Effect.scoped);

      expect(error._tag).toBe("ConfigError");
    }),
  );
});
