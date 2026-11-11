/**
 * The one export of `cloudflare:workers` that `web` reads: its bindings. The shape repeats `WebEnv`
 * in `env.ts`, which an ambient module cannot import; change both together.
 */
declare module "cloudflare:workers" {
  export const env: {
    readonly API: {
      readonly fetch: (
        request: Request,
        init?: { readonly signal?: AbortSignal },
      ) => Promise<Response>;
    };
    readonly AUTH: {
      readonly fetch: (
        request: Request,
        init?: { readonly signal?: AbortSignal },
      ) => Promise<Response>;
    };
    readonly AUTH_METHODS: string;
    readonly AUTH_ORPHAN_GRACE_SECONDS: string;
    readonly KNOBS?: {
      readonly get: (key: string, options: { readonly cacheTtl: number }) => Promise<string | null>;
    };
    readonly PUBLIC_ORIGIN: string;
    readonly RATELIMIT_CREDENTIAL: {
      readonly limit: (options: { readonly key: string }) => Promise<{ readonly success: boolean }>;
    };
    readonly RATELIMIT_PUBLIC: {
      readonly limit: (options: { readonly key: string }) => Promise<{ readonly success: boolean }>;
    };
  };
}

declare module "*.css?url" {
  const url: string;

  export default url;
}
