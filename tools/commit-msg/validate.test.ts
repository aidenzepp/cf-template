import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { validate } from "./validate.ts";

const scopes = ["web", "api", "infra"];

const trailerMessage =
  "Remove the `Co-Authored-By:` trailer. AI disclosure goes in the pull request body (see /pr-authoring); this repository does not record it in commits.";

describe("validate", () => {
  describe("ignore patterns", () => {
    it.each([
      ["merge branch", "Merge branch 'dep'"],
      ["merge tag", "Merge tag 'v1.0.0'"],
      ["revert", 'Revert "feat: x"'],
      ["reapply", 'Reapply "feat: x"'],
      ["fixup", "fixup! feat: x"],
      ["semver", "chore(release): 1.2.3-rc.1+build.5 [skip ci]"],
      ["merged into", "Merged feature into main"],
      ["remote-tracking", "Merge remote-tracking branch 'origin/main'"],
      ["automatic merge", "Automatic merge of main"],
      ["auto-merged", "Auto-merged a into b"],
    ])("accepts %s", (_name, message) => {
      assert.isTrue(Option.isNone(validate(message, scopes)));
    });
  });

  it("accepts a typed, scoped header", () => {
    assert.isTrue(Option.isNone(validate("feat(web): add x", scopes)));
  });

  it("accepts a scope from the extra list and a breaking mark", () => {
    assert.isTrue(Option.isNone(validate("fix(tools)!: drop y", scopes)));
  });

  it("rejects an unknown type", () => {
    assert.match(Option.getOrThrow(validate("wip: x", scopes)), /type `wip`/u);
  });

  it("rejects an unknown scope", () => {
    assert.match(Option.getOrThrow(validate("feat(nope): x", scopes)), /scope `nope`/u);
  });

  it("rejects a header without a subject", () => {
    assert.match(Option.getOrThrow(validate("feat: ", scopes)), /header must be/u);
  });

  it("rejects a Co-Authored-By trailer", () => {
    const message = "feat: x\n\nCo-Authored-By: Someone <someone@example.com>\n";

    assert.strictEqual(Option.getOrThrow(validate(message, scopes)), trailerMessage);
  });
});
