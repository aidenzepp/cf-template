import { fetchMessage } from "./restricted-properties.ts";

/**
 * The `no-restricted-globals` entries of source code that name no registry exception: abort
 * through `Atom.fn` or a loader, client storage through `Atom.kvs`, and platform access through
 * `@effect/platform-bun`. `AbortController` is split out so a lifted file can drop only it.
 */
export const abortGlobal = {
  message:
    "interrupt through Atom.fn or the loader signal, not AbortController (docs/capabilities.md, Server data, async UI and mutation state)",
  name: "AbortController",
};

/**
 * The storage and platform globals every source file keeps banned.
 */
export const platformGlobals = [
  ...["localStorage", "sessionStorage"].map((name) => ({
    message: `client storage goes through KeyValueStore.layerStorage and Atom.kvs, never ${name} (docs/capabilities.md, Client storage)`,
    name,
  })),
  {
    message:
      "use the @effect/platform-bun services, never Bun (docs/capabilities.md, Platform APIs)",
    name: "Bun",
  },
];

/**
 * The bare `fetch` entry of source outside `apps/web`; `web` keeps its own message.
 */
export const sourceFetch = {
  message: "HTTP goes through HttpClient and HttpApiClient (docs/capabilities.md, HTTP)",
  name: "fetch",
};

/**
 * The bare `fetch` entry of `apps/web`: only the AUTH binding is called.
 */
export const webFetch = { message: fetchMessage, name: "fetch" };
