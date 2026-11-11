import { assert, describe, it } from "@effect/vitest";
import * as EffectModule from "effect/Effect";
import config from "../../vite.config.ts";
import { basePaths } from "./rules/restrict-imports.ts";
import { runMembers, runNames } from "./rules/restricted-properties.ts";

/**
 * The `run[A-Z]*` exports of `effect/Effect` at the installed pin.
 */
const installed = Object.keys(EffectModule).filter((name) => /^run[A-Z]/u.test(name));

describe("the Effect.run* family", () => {
  it("the configured names equal the run exports of effect/Effect", () => {
    assert.sameMembers([...runNames], installed);
  });

  it("the member form bans every installed run export in the root rule", () => {
    const rule = config.lint?.rules?.["no-restricted-properties"];

    assert.deepStrictEqual(rule, ["error", ...runMembers]);
    assert.sameMembers(
      runMembers.map(({ property }) => property),
      installed,
    );
  });

  it("the import form bans every installed run export from effect and effect/Effect", () => {
    assert.sameMembers(
      basePaths.map(({ name }) => name),
      ["effect", "effect/Effect"],
    );

    for (const path of basePaths) {
      assert.sameMembers([...(path.importNames ?? [])], installed);
    }
  });
});
