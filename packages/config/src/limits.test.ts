import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { AUTH_PASSWORD_SCRYPT } from "./auth-password.ts";
import {
  API_CPU_LIMIT_MS,
  CPU_LIMIT_HEADROOM,
  WEB_CPU_LIMIT_MS,
  WORKER_SUBREQUEST_LIMIT,
  authCpuLimitMs,
  limitsFor,
  scryptCostMs,
} from "./limits.ts";

const reference = { ln: 15, p: 3, r: 8 };

const defaults = {
  apiCpuMs: API_CPU_LIMIT_MS.default,
  headroom: CPU_LIMIT_HEADROOM.default,
  scrypt: AUTH_PASSWORD_SCRYPT.default,
  subrequests: WORKER_SUBREQUEST_LIMIT.default,
  webCpuMs: WEB_CPU_LIMIT_MS.default,
};

describe("scryptCostMs", () => {
  it("is the 115 ms anchor at the default cost", () => {
    assert.strictEqual(scryptCostMs(reference), 115);
  });
});

describe("authCpuLimitMs", () => {
  it("is 1150 ms at the default headroom and cost", () => {
    assert.strictEqual(authCpuLimitMs(10, reference), 1150);
  });

  it.each([{ ln: 13, p: 10, r: 8 }, reference, { ln: 17, p: 1, r: 8 }])(
    "never falls below one hash at $ln/$r/$p",
    (cost) => {
      for (const headroom of [1, 2, 10]) {
        assert.isAtLeast(authCpuLimitMs(headroom, cost), scryptCostMs(cost));
      }
    },
  );
});

describe("CPU_LIMIT_HEADROOM", () => {
  it.effect.each(["0", "0.5"])("rejects %s", (raw) =>
    Effect.gen(function* rejects() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(CPU_LIMIT_HEADROOM.decode(raw))));
    }),
  );

  it.effect("decodes 10", () =>
    Effect.gen(function* decodes() {
      assert.strictEqual(yield* CPU_LIMIT_HEADROOM.decode("10"), 10);
    }),
  );
});

describe("limitsFor", () => {
  it("derives the auth CPU limit from the hash cost", () => {
    assert.deepStrictEqual(limitsFor("auth", defaults), { cpuMs: 1150, subrequests: 100 });
  });

  it.each(["web", "api"] as const)("gives %s its own CPU knob", (worker) => {
    assert.deepStrictEqual(limitsFor(worker, defaults), { cpuMs: 500, subrequests: 100 });
  });
});
