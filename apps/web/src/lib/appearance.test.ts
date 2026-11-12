import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { KeyValueStore } from "effect/persistence";
import {
  APPEARANCE_KEY,
  Appearance,
  DARK_QUERY,
  THEME_SCRIPT,
  resolveAppearance,
} from "./appearance.ts";
import { settingsTab } from "./settings-tab.ts";

describe("appearance", () => {
  it("follows the browser only for system", () => {
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("system", false)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
    expect(resolveAppearance("light", true)).toBe("light");
  });

  it.effect("is stored as a JSON string, which the pre-paint script parses", () =>
    Effect.gen(function* stored() {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* KeyValueStore.toSchemaStore(store, Appearance).set(APPEARANCE_KEY, "dark");

      expect(yield* store.get(APPEARANCE_KEY)).toBe('"dark"');
      expect(THEME_SCRIPT).toContain(`JSON.parse(localStorage.getItem("${APPEARANCE_KEY}"))`);
      expect(THEME_SCRIPT).toContain(DARK_QUERY);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );
});

describe("settings tab", () => {
  it("keeps a tab and drops any other value", () => {
    expect(settingsTab("account")).toBe("account");
    expect(settingsTab("developer")).toBe("developer");
    expect(settingsTab("billing")).toBeUndefined();
    expect(settingsTab(undefined)).toBeUndefined();
  });
});
