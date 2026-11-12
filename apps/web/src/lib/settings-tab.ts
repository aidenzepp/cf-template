import { Option, Schema } from "effect";
import { flow } from "effect/Function";

/**
 * The tabs of `/settings`, in the order they show.
 */
export const SettingsTab = Schema.Literals(["preferences", "account", "developer"]);

const decodeTab = Schema.decodeUnknownOption(SettingsTab);

/**
 * Reduce the raw `tab` query value of `/settings` to a tab. Anything else is dropped, so the page
 * shows its first tab and the address bar never carries an unknown value.
 *
 * Takes the raw `tab` query value and returns the tab when it is one, otherwise `undefined`.
 */
export const settingsTab = flow(decodeTab, Option.getOrUndefined);
