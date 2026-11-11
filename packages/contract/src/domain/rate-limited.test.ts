import { assert, describe, it } from "@effect/vitest";
import { RateLimited } from "./rate-limited.ts";

describe("RateLimited", () => {
  it("is the 429 problem at /problems/rate-limited", () => {
    const problem = new RateLimited({ retryAfterSeconds: 10 });

    assert.strictEqual(problem.type, "/problems/rate-limited");
    assert.strictEqual(problem.status, 429);
  });
});
