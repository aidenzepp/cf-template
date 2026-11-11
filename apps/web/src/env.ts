/**
 * The calls `web` makes on a service binding: a fetch of a web `Request`.
 */
export interface ServiceBinding {
  readonly fetch: (request: Request, init?: { readonly signal?: AbortSignal }) => Promise<Response>;
}

/**
 * The bindings of the `web` Worker. `infra/src/web.ts` declares them and imports this type only.
 */
export interface WebEnv {
  readonly API: ServiceBinding;
  readonly AUTH: ServiceBinding;
  readonly AUTH_METHODS: string;
  readonly PUBLIC_ORIGIN: string;
}
