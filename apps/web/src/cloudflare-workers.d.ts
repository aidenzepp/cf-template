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
    readonly PUBLIC_ORIGIN: string;
  };
}

declare module "*.css?url" {
  const url: string;

  export default url;
}
