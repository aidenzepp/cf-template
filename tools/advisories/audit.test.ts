import { assert, describe, it } from "@effect/vitest";

import { auditArguments } from "./audit.ts";

describe("auditArguments", () => {
  it("asks for the moderate threshold and ignores nothing by default", () => {
    assert.deepStrictEqual(auditArguments([]), ["audit", "--audit-level=moderate"]);
  });

  it("appends one --ignore pair per suppression", () => {
    assert.deepStrictEqual(auditArguments(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]), [
      "audit",
      "--audit-level=moderate",
      "--ignore",
      "GHSA-aaaa-bbbb-cccc",
      "--ignore",
      "GHSA-dddd-eeee-ffff",
    ]);
  });
});
