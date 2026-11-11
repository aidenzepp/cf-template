import type { RateLimitBinding } from "./ratelimit.ts";

/**
 * The calls `web` makes on a service binding: a fetch of a web `Request`.
 */
export interface ServiceBinding {
  readonly fetch: (request: Request, init?: { readonly signal?: AbortSignal }) => Promise<Response>;
}

/**
 * The one call `web` makes on the knobs namespace: a read of a key, cached at the edge for
 * `cacheTtl` seconds. It answers `null` for a key that holds nothing.
 */
export interface KnobsBinding {
  readonly get: (key: string, options: { readonly cacheTtl: number }) => Promise<string | null>;
}

/**
 * The bindings of the `web` Worker. `infra/src/web.ts` declares them and imports this type only.
 */
export interface WebEnv {
  readonly API: ServiceBinding;
  readonly AUTH: ServiceBinding;
  readonly AUTH_METHODS: string;
  readonly AUTH_ORPHAN_GRACE_SECONDS: string;
  readonly KNOBS: KnobsBinding;
  readonly PUBLIC_ORIGIN: string;
  readonly RATELIMIT_CREDENTIAL: RateLimitBinding;
  readonly RATELIMIT_PUBLIC: RateLimitBinding;
}
