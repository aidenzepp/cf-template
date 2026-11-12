import { Schema } from "effect";
import { Atom } from "effect/reactivity";
import { KeyValueStore } from "effect/persistence";

/**
 * The appearance the person chose: a fixed theme, or the browser's own preference.
 */
export const Appearance = Schema.Literals(["light", "dark", "system"]);

/**
 * The key of the appearance in the browser's storage. The pre-paint script reads the same key.
 */
export const APPEARANCE_KEY = "appearance";

/**
 * The media query of the browser's dark preference.
 */
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The theme the page paints with, from the chosen appearance and the browser's preference.
 *
 * @param appearance - The chosen appearance.
 * @param systemDark - Whether the browser prefers dark.
 * @returns `dark` when the appearance is dark, or is `system` and the browser prefers dark.
 */
export const resolveAppearance = (
  appearance: typeof Appearance.Type,
  systemDark: boolean,
): "light" | "dark" =>
  appearance === "dark" || (appearance === "system" && systemDark) ? "dark" : "light";

/**
 * Sets the `dark` class of the document before the first paint, from the stored appearance (a JSON
 * string, as `Atom.kvs` writes it) or, with none or an unreadable one, from the browser's
 * preference. It is plain text because it runs before any module does.
 */
export const THEME_SCRIPT = `(function(){var a="system";try{var v=JSON.parse(localStorage.getItem("${APPEARANCE_KEY}"));if(v==="light"||v==="dark"){a=v}}catch(e){}document.documentElement.classList.toggle("dark",a==="dark"||(a==="system"&&matchMedia("${DARK_QUERY}").matches))})()`;

/**
 * The runtime of the storage-backed atoms: the browser's local storage as a `KeyValueStore`. On the
 * server there is no storage, so a read fails and the atom keeps its default.
 */
const storageRuntime = Atom.runtime(KeyValueStore.layerStorage(() => globalThis.localStorage));

/**
 * The chosen appearance, kept in the browser's storage under {@link APPEARANCE_KEY}. It is `system`
 * until the person chooses.
 */
export const appearanceAtom = Atom.kvs({
  defaultValue: () => "system" as const,
  key: APPEARANCE_KEY,
  runtime: storageRuntime,
  schema: Appearance,
}).pipe(Atom.keepAlive);

/**
 * Whether the browser prefers dark, kept current while the atom is read. It is `false` where there
 * is no `matchMedia` (the server).
 */
const systemDarkAtom = Atom.make((get) => {
  if (typeof matchMedia === "undefined") {
    return false;
  }

  const query = matchMedia(DARK_QUERY);

  const onChange = () => {
    get.setSelf(query.matches);
  };

  query.addEventListener("change", onChange);
  get.addFinalizer(() => {
    query.removeEventListener("change", onChange);
  });

  return query.matches;
}).pipe(Atom.keepAlive);

/**
 * The theme the page paints with now: the chosen appearance resolved against the browser's
 * preference.
 */
export const resolvedThemeAtom = Atom.make((get) =>
  resolveAppearance(get(appearanceAtom), get(systemDarkAtom)),
);
