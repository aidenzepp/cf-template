import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import type { Layer } from "effect";

/**
 * The request fields every key operation of the command passes.
 */
interface KeyRequest {
  accountId: string;
  keyName: string;
  namespaceId: string;
}

/**
 * A type-check fixture for the undocumented subpaths `alchemy.ts` imports. It runs nothing: it
 * fails `bun run check` when `CloudflareApiLive` or `AuthProvidersLive` stops being a layer, or a
 * KV operation loses or renames a request field the command passes.
 */
export const subpaths = {
  api: CloudflareApiLive satisfies () => Layer.Layer<never, object, object>,
  authProviders: AuthProvidersLive satisfies Layer.Layer<never, object, object>,
  deleteValue: kv.deleteNamespaceValue satisfies (request: KeyRequest) => object,
  getValue: kv.getNamespaceValue satisfies (request: KeyRequest) => object,
  listKeys: kv.listNamespaceKeys.items satisfies (request: Omit<KeyRequest, "keyName">) => object,
  listNamespaces: kv.listNamespaces.items satisfies (request: { accountId: string }) => object,
  putValue: kv.putNamespaceValue satisfies (
    request: KeyRequest & { metadata: { setAt: string }; value: string },
  ) => object,
};
