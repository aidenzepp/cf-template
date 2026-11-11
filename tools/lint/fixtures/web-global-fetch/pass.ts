export const forwarded = (env: { AUTH: { fetch: (request: Request) => Promise<Response> } }) =>
  env.AUTH.fetch(new Request("https://auth/session"));
